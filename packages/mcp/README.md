# @webhooks-cc/mcp

MCP server for [webhooks.cc](https://webhooks.cc). It gives coding agents direct access to webhook testing workflows: create endpoints, send signed test webhooks, inspect captures, compare attempts, verify signatures, and read recent webhook context through MCP resources.

The easiest way in is the [remote server](#remote-server) at `https://webhooks.cc/mcp`, for any client that can add a remote MCP server (Claude Code, Cursor, VS Code, Codex, claude.ai, ChatGPT): you approve it once in your browser, with no key and nothing to install. This package is the local server, for sends to a handler on your machine, its prompts and resources, a keyless sandbox, and CI. It works with Claude Code, Cursor, VS Code, Codex, Devin Desktop (formerly Windsurf), and Claude Desktop.

## Install

No API key is needed. Without one, the server starts with the full tools for the account a human connected the agent to before, or else in the keyless [agent sandbox](#without-an-api-key-the-agent-sandbox). It reads:

- `WHK_API_KEY` (optional) for an API key, which always wins over a saved connection
- `WHK_AGENT_FILE` for where the sandbox and the connection are saved (default `~/.config/whk/agent.json`, see [the agent credential file](#the-agent-credential-file))
- `WHK_BASE_URL` for a custom API base URL
- `WHK_WEBHOOK_URL` for a custom receiver base URL

### Claude Code plugin

The plugin installs the server together with a webhook testing skill that tells Claude when to use it:

```text
/plugin install webhooks-cc --marketplace kroqdotdev/webhooks-cc
```

For other agents, `npx skills add kroqdotdev/webhooks-cc` installs the same skill. See [Agent skill](https://webhooks.cc/docs/mcp/skills).

### Remote server

`https://webhooks.cc/mcp` serves the same tools over streamable HTTP, with nothing to install. The client opens webhooks.cc in the browser once; the human signs in and clicks Connect (OAuth 2.1 with PKCE, no code to type), and can disconnect it later under Account, Connected agents.

- **Claude Code**: `claude mcp add -s user --transport http webhooks-cc https://webhooks.cc/mcp`, then `/mcp` in Claude Code to sign in
- **Codex**: `codex mcp add webhooks-cc --url https://webhooks.cc/mcp` (it opens the browser to sign in; if it does not, `codex mcp login webhooks-cc`)
- **Cursor** (`.cursor/mcp.json`): `{ "mcpServers": { "webhooks-cc": { "url": "https://webhooks.cc/mcp" } } }`
- **VS Code** (`.vscode/mcp.json`): `{ "servers": { "webhooks-cc": { "type": "http", "url": "https://webhooks.cc/mcp" } } }`
- **claude.ai and Claude Desktop**: Settings, Connectors, add a custom connector with the URL `https://webhooks.cc/mcp`
- **ChatGPT**: add it as a custom connector (developer mode)

A client that can send headers may use an API key instead: `Authorization: Bearer whcc_...`. The remote server has 44 tools: `send_to` and `replay_request` are left out and `targetUrl` is refused, because a hosted server cannot reach your machine, and waits are capped at 50 seconds. It needs an account (no sandbox), and serves tools only, without prompts or resources.

### One-click

- **Cursor**: [Add to Cursor](https://cursor.com/en/install-mcp?name=webhooks-cc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB3ZWJob29rcy1jYy9tY3AiXSwiZW52Ijp7IldIS19BUElfS0VZIjoid2hjY18uLi4ifX0=)
- **VS Code**: [Add to VS Code](https://insiders.vscode.dev/redirect/mcp/install?name=webhooks-cc&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40webhooks-cc%2Fmcp%22%5D%2C%22env%22%3A%7B%22WHK_API_KEY%22%3A%22%24%7Binput%3Awhk_api_key%7D%22%7D%7D&inputs=%5B%7B%22id%22%3A%22whk_api_key%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22webhooks.cc%20API%20key%20%28get%20yours%20at%20webhooks.cc%2Faccount%29%22%2C%22password%22%3Atrue%7D%5D)

Both links set `WHK_API_KEY`; to start without a key, use the commands below.

### CLI

```bash
# Claude Code
claude mcp add -s user --transport stdio webhooks-cc -- npx -y @webhooks-cc/mcp

# OpenAI Codex
codex mcp add webhooks-cc -- npx -y @webhooks-cc/mcp

# Or let setup write the config
npx @webhooks-cc/mcp setup claude-code
npx @webhooks-cc/mcp setup cursor
npx @webhooks-cc/mcp setup vscode
npx @webhooks-cc/mcp setup codex
npx @webhooks-cc/mcp setup devin    # Devin Desktop, formerly Windsurf ("windsurf" works too)
npx @webhooks-cc/mcp setup claude-desktop
```

To start with an API key, add `-e WHK_API_KEY=whcc_...` to the `mcp add` commands, or `--api-key whcc_...` to `setup`.

### Manual config

```json
{
  "mcpServers": {
    "webhooks-cc": {
      "command": "npx",
      "args": ["-y", "@webhooks-cc/mcp"],
      "env": {
        "WHK_API_KEY": "whcc_..."
      }
    }
  }
}
```

Leave out `env` to start without a key. Get your API key at [webhooks.cc/account/api-keys](https://webhooks.cc/account/api-keys).

## What it exposes

The server exposes `46` tools, `3` prompts, and `3` resource surfaces with an API key, the same `46` tools and the prompts with a saved connection, and `11` sandbox tools otherwise. The remote server exposes `44` tools.

### Endpoint tools

- `create_endpoint`
- `list_endpoints`
- `get_endpoint`
- `update_endpoint`
- `preview_response`
- `delete_endpoint`
- `create_endpoints`
- `delete_endpoints`

### Request tools

- `list_requests`
- `search_requests`
- `count_requests`
- `get_request`
- `wait_for_request`
- `wait_for_requests`
- `replay_request`
- `compare_requests`
- `generate_payload_schema` (TypeScript, Zod, Pydantic, or JSON Schema from captured bodies)
- `extract_from_request`
- `verify_signature`
- `clear_requests`

### Email tools

Every endpoint on an account receives email at `{slug}@mailhooks.cc` (and `{slug}+{tag}@mailhooks.cc`). These tools read it, with the one-time code and main link already picked out, unless the endpoint's owner turned that off:

- `list_emails`
- `get_email`
- `wait_for_email`
- `send_test_email`
- `render_email` (an email in Postmark, SendGrid, Mailgun or CloudMailin shape, optionally posted to your local inbound handler)

The request tools and resources return emails too (filter with `kind`), without the raw message or the HTML part and with the text cut at 8,000 characters; `get_email` returns the HTML.

### Forwarding tools

Send captured HTTP requests and emails to up to 10 destinations (your servers, Slack or Discord
channels, Zapier or n8n), each with its own kinds, conditions, format (as received, signed JSON,
a JSON body you shape with placeholders, or a chat message), throttle, delay and signing secret,
retried and logged (owner only):

- `list_destinations`, `add_destination`, `update_destination`, `remove_destination`
- `preview_destination` (dry run: does the filter pass, and the exact request it would send)
- `configure_forwarding` (the primary destination: URL, on/off, kinds, format, your headers, path, retries, order, sent time field)
- `get_forwarding_secret` (returns a destination's `whsec_` secret; with `rotate: true`, replaces it)
- `test_forwarding` (sends one request to a destination and reports the answer)
- `list_deliveries` (the delivery log with its counts, by destination, or every try of one request)
- `redeliver` (one request, to one destination or all, or every failed delivery of an endpoint)

### Send and test tools

- `send_webhook`
- `send_to`
- `preview_webhook`
- `test_webhook_flow`

### Team tools

- `list_teams`
- `list_team_members`
- `share_endpoint`
- `unshare_endpoint`

Endpoints shared with you already appear in `list_endpoints` (with `fromTeam`) and work with every request tool except `clear_requests`, which stays with the owner. Invites are not exposed: accepting one claims a paid seat.

### Discovery and account tools

- `list_provider_templates`
- `get_usage` (personal plan plus each subscribed team's pool)
- `describe`

### Without an API key: the agent sandbox

Started without `WHK_API_KEY`, the server starts with the full tools when [the agent credential file](#the-agent-credential-file) holds a live connection to a human's account. Otherwise it registers sandbox tools instead ([auth.md](https://webhooks.cc/auth.md)):

- `create_endpoint`, `list_endpoints`, `get_endpoint`, `delete_endpoint`, `list_requests`, `get_request`, `wait_for_request`, `generate_payload_schema`: the same names and arguments as the full tools, in a sandbox of up to 3 endpoints, 25 captured requests each and 100 in all, for 24 hours. The first `create_endpoint` registers it (a few seconds of proof of work).
- `connect_account`: returns a link and a 6-digit code for a human to connect the agent to their account. Pass the email they sign in to webhooks.cc with.
- `wait_for_connection`: waits for the human, then replaces the sandbox tools with the full tools for that account (`notifications/tools/list_changed`) and saves the connection.
- `about_sandbox`: the limits and how to connect, without a network call.

The human approves the agent once: later sessions start connected, for 90 days. When they disconnect the agent under Account, Connected agents, the sandbox tools come back. A sandbox made in an earlier session cannot move into the account, because only the process that registered holds the claim token; `connect_account` then connects through a new registration and says so, and the old endpoints stay in the sandbox until they expire.

### The agent credential file

The sandbox and the connection are saved in `~/.config/whk/agent.json` (`$XDG_CONFIG_HOME/whk/agent.json` when set; `~/Library/Application Support/whk/agent.json` on macOS; `%APPDATA%\whk\agent.json` on Windows), or wherever `WHK_AGENT_FILE` points. The [TypeScript](https://webhooks.cc/docs/sdk), [Python](https://webhooks.cc/docs/sdk/python) and [Go](https://webhooks.cc/docs/sdk/go) SDKs and the [`whk` CLI](https://webhooks.cc/docs/cli/commands#sandbox) share it, so a connection made in one works in all of them. It is written atomically with mode `0600`, holds identity assertions and short-lived tokens (never the claim token), and an API key always wins over it. The format is described in [AI agents](https://webhooks.cc/docs/agents#the-agent-credential-file) and specified in [agent-credentials.md](https://github.com/kroqdotdev/webhooks-cc/blob/main/packages/sdk/conformance/agent-credentials.md).

## Prompts

The server exposes MCP prompts for common workflows:

- `debug_webhook_delivery`
- `setup_provider_testing`
- `compare_webhook_attempts`

These prompts do not execute anything on their own. They give the client a structured starting point for multi-step agent work.

## Resources

The server exposes MCP resources for recent webhook context:

- `webhooks://endpoints`
- `webhooks://endpoint/{slug}/recent`
- `webhooks://request/{id}`

These are useful when the client supports resource browsing or prompt/resource attachment.

## Provider support

Provider template and signing support includes:

- `stripe`
- `github`
- `shopify`
- `twilio`
- `slack`
- `paddle`
- `linear`
- `sendgrid`
- `clerk`
- `discord`
- `vercel`
- `gitlab`
- `typeform`
- `standard-webhooks`
- `meta`
- `lemonsqueezy`
- `coinbase-commerce`
- `razorpay`
- `cal`
- `intercom`
- `telegram`
- `square`
- `hubspot`
- `mailgun`
- `calendly`
- `mux`
- `sentry`
- `bitbucket`
- `docusign`
- `adyen`
- `paypal`
- `plaid`
- `resend`
- `workos`

Signature verification also supports:

- all template providers except `sendgrid` (IP allowlisting) and `plaid` (JWT/JWK verification requires Plaid API credentials)

Use `list_provider_templates` to inspect templates, default events, signature headers, and signing requirements from the agent.

## Example workflows

Typical agent flows:

- Create an ephemeral endpoint, send a provider-signed webhook, and wait for capture
- Search retained requests across endpoints with full-text filters
- Compare two webhook attempts and extract only the JSON fields you care about
- Verify a captured signature against a known secret
- Run `test_webhook_flow` to create, send, capture, verify, replay, and clean up in one tool call

## Programmatic use

The package also exports `createServer()`, `registerTools()`, `registerSandboxTools()`, `registerPrompts()`, and `registerResources()` if you want to embed the server yourself. `createServer()` without `apiKey` takes `credentialsFile` (a path, or `false` to keep the sandbox and the connection in memory). `registerTools(server, client, { remote: true })` applies the remote server's restrictions; it is also exported from `@webhooks-cc/mcp/tools`.

```ts
import { createServer } from "@webhooks-cc/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createServer({
  apiKey: process.env.WHK_API_KEY!,
  baseUrl: process.env.WHK_BASE_URL,
  webhookUrl: process.env.WHK_WEBHOOK_URL,
});

await server.connect(new StdioServerTransport());
```

## Example conversation

```text
You: Create an ephemeral endpoint for GitHub webhook testing.

Agent: Created endpoint https://go.webhooks.cc/w/abc123 and marked it ephemeral.

You: Preview the signed request for a push event before sending it.

Agent: Here is the exact method, headers, and JSON body that would be sent.

You: Send it, wait for two requests, and compare them.

Agent: Sent the webhook, captured two requests, and here are the header and body differences.
```

## Documentation

Full docs: [webhooks.cc/docs/mcp](https://webhooks.cc/docs/mcp)

## License

MIT
