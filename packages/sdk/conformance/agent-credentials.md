# The agent credential file

An agent that registered with webhooks.cc (see `/auth.md`) holds an identity assertion. The MCP server, the TypeScript, Python and Go SDKs and the `whk` CLI keep it in one shared file, so a connection a human approved once survives restarts and works from every tool. `agent-credentials.json` holds the vectors every implementation must pass.

## Where it lives

1. `WHK_AGENT_FILE`, when set and not empty, is the full path of the file.
2. Otherwise `<config>/whk/agent.json`, where `<config>` is the directory the CLI already keeps `token.json` in (Rust's `dirs::config_dir()`):
   - Windows: `%APPDATA%`.
   - macOS: `$HOME/Library/Application Support`.
   - Everything else: `$XDG_CONFIG_HOME` when it is set to an absolute path, else `$HOME/.config`.

When these rules give no directory (no home directory, and no `APPDATA` or absolute `XDG_CONFIG_HOME` to stand in for one), there is no file: tools work as if it were empty and never write.

## Format

UTF-8 JSON, version 1:

```json
{
  "version": 1,
  "issuers": {
    "https://webhooks.cc": {
      "claimed": {
        "registration_id": "6f1c2d4e-8a1b-4c3d-9e2f-0a1b2c3d4e5f",
        "identity_assertion": "eyJhbGciOiJFUzI1NiIs...",
        "assertion_expires": "2027-01-26T09:00:00.000Z",
        "scope": "webhooks:read webhooks:write",
        "email": "dev@example.com",
        "client_name": "webhooks-cc-mcp",
        "saved_at": "2026-10-28T09:00:00.000Z",
        "access_token": "whcc_...",
        "access_token_expires": "2026-10-28T10:00:00.000Z"
      },
      "sandbox": {
        "registration_id": "0d9e8f7a-6b5c-4d3e-2f1a-0b9c8d7e6f5a",
        "identity_assertion": "eyJhbGciOiJFUzI1NiIs...",
        "assertion_expires": "2026-10-29T09:00:00.000Z",
        "client_name": "whk-cli",
        "saved_at": "2026-10-28T09:00:00.000Z"
      }
    }
  }
}
```

- The key under `issuers` is the app's base URL, normalised: trailing `/` characters removed, and the scheme and host (everything before the first `/` after `://`) lowercased. `https://WebHooks.cc/` and `https://webhooks.cc` are the same issuer. A local stack (`http://localhost:3000`) never touches production's entry.
- `claimed` is a registration a human connected to their account: its assertion mints tokens that act for that account (90 days). `sandbox` is an unclaimed anonymous registration (24 hours, sandbox only).
- A slot needs `registration_id`, `identity_assertion` and `assertion_expires`, each a non-empty string. A slot missing one of them, or holding something else, does not exist.
- Timestamps are RFC 3339 with an uppercase `T`, and `Z` or a numeric offset, with or without fractions of a second: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`, and a real date and time (no February 30, no hour 24, no second 60). Anything else is not a timestamp.
- `scope`, `email`, `client_name` and `saved_at` are informational.
- `access_token` and `access_token_expires` are an optional cache of the last token exchanged from that assertion, so short-lived processes (each CLI command, each script run) do not exchange on every start. A cached token is usable when it starts with `whcc_` and expires more than 60 seconds from now.
- A slot is live when its assertion expires more than 60 seconds from now. Readers ignore other slots.

The claim token (`clm_...`) is never written. It stays in the memory of the process that registered, as `/auth.md` asks, which means only that process can move its sandbox endpoints into an account. A later process that wants to connect an account starts a `service_auth` registration for the human instead (a new code, the sandbox endpoints stay in the sandbox until they expire).

## Reading

- A missing file, unreadable JSON, a top-level value that is not an object, a missing `version`, or a `version` other than the number 1 reads as empty. Never fail a command because the file is broken, and never print its contents, not even in debug output or error messages.
- An explicit API key always wins: with `WHK_API_KEY` (or a key passed in code) tools do not read the file at all.
- Otherwise a live `claimed` slot for the issuer gives account access; failing that, a live `sandbox` slot is reused instead of registering again.

## Writing

1. Create the parent directory if it is missing, with mode `0700` on Unix.
2. Read the file again right before writing. If it is a JSON object with a `version` key other than the number 1, leave it alone and skip writing (a newer tool owns it). Any other file that is not version 1 (unreadable, not an object, no `version`) is replaced.
3. Change only the one slot (set or remove it). Keep other issuers, and unknown keys at the top level and in the issuer objects, as they were. Drop `claimed` and `sandbox` slots that are no longer live or not well formed, issuer values that are not objects, and issuers left with no keys at all.
4. If no issuer is left, delete the file. Otherwise write the JSON to a new temporary file in the same directory (`agent.json.<random>.tmp`, created exclusively with mode `0600`), flush it to disk, and rename it over `agent.json`. Remove the temporary file if anything fails.

Writes that follow from using a slot are conditional: caching a new access token, and removing a slot after `invalid_grant` (or `sandbox_closed`), apply only while the file's slot still holds the same `registration_id`. Several processes share the file, and one that still holds an old registration must never overwrite or remove the slot another process has replaced (a human reconnected the agent) or removed (`whk sandbox forget`). Saving a new registration (after registering, or after a claim) is unconditional.

A file that exists but cannot be read (permissions, a Windows sharing violation during another process's rename) reads as empty and is never written over; only a missing file counts as no file.

Writes are best effort: a write that fails (read-only home, full disk) is reported at most as a one-line warning without contents, and the command goes on with what it has in memory.

## Using a slot

- Exchange the assertion at `POST <issuer>/api/oauth2/token` (form-encoded `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion`) when there is no usable cached token, and store the new token and its expiry in the slot. Leave `resource` out: the server compares it with its own public URL, which a client reaching it under another name (a local stack, a loopback address) would not match.
- When the API answers 401 to a cached or fresh token, exchange once more.
- When the exchange answers `invalid_grant`, the registration expired, was revoked or was claimed: remove the slot (conditionally, as above). For `claimed` that means the human disconnected the agent, so fall back to the sandbox; for `sandbox`, register a new one when one is needed.
- After a successful claim, write the `claimed` slot (the registration id is the one the claim was started for) and remove the `sandbox` slot when it holds the same registration.
