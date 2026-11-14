# webhooks.cc for coding agents

A skill that tells coding agents what webhooks.cc can do and which tool to
reach for: capture URLs and inboxes, provider-signed test webhooks and
signature checks, signup and code emails, mock responses, forwarding to
servers, Slack, Discord, Google Sheets or file drops, email parsing, and
tunnels and preview links for a local app. It is short, so it costs little
context; the detail sits in reference files the agent reads when a task
needs it. In Claude Code it comes as a plugin together with the
[webhooks.cc MCP server](https://www.npmjs.com/package/@webhooks-cc/mcp).

With it, asking an agent to "build the Stripe webhook handler and test it"
makes the agent capture real deliveries, generate types from them, send
signed payloads to the local route, and check the result, instead of
guessing the payload or switching off the signature check.

## Install

### Cursor, Codex, GitHub Copilot, Gemini CLI, OpenCode and others

Install the skill with the [skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add kroqdotdev/webhooks-cc
```

Then add the MCP server: the remote server at `https://webhooks.cc/mcp`
(approve it once in the browser), or the local one:

```bash
npx @webhooks-cc/mcp setup cursor --api-key whcc_...
```

`setup` also takes `claude-code`, `claude-desktop`, `vscode`, `codex` and
`devin` (Devin Desktop, formerly Windsurf; `windsurf` works too).

### Claude Code

```text
/plugin install webhooks-cc --marketplace kroqdotdev/webhooks-cc
```

On Claude Code before 2.1.275, add the marketplace first:

```text
/plugin marketplace add kroqdotdev/webhooks-cc
/plugin install webhooks-cc@webhooks-cc
```

Claude Code asks for an API key when you enable the plugin. Leave it empty to
start in the keyless sandbox (3 endpoints for 24 hours); the agent can connect
it to your account later. Keys are at
[webhooks.cc/account/api-keys](https://webhooks.cc/account/api-keys). Call the
skill by name with `/webhooks-cc:webhooks-cc`.

### From the MCP servers

Both MCP servers, the remote one at `https://webhooks.cc/mcp` and the local
`@webhooks-cc/mcp`, serve the same skill to clients that support MCP skills.

### By hand

Copy [`skills/webhooks-cc`](skills/webhooks-cc) into your agent's skills
folder, for example `.agents/skills/` or `.claude/skills/`.

### Any agent that reads AGENTS.md

Add this to the project's `AGENTS.md` (or `CLAUDE.md`):

```markdown
## Webhooks

Use webhooks.cc (the webhooks-cc MCP tools, `whk`, or `@webhooks-cc/sdk` in
tests) for webhooks, test email and public URLs for local apps. Test webhook
handlers with provider-signed payloads (the MCP tool `send_to`, or `sendTo`
in tests), never by disabling signature checks, and generate payload types
from captured requests with `generate_payload_schema`.
```

## What is inside

- `skills/webhooks-cc/SKILL.md`: what webhooks.cc is, which interface to use
  (MCP tools, `whk`, SDKs), tool groups, the sandbox, approvals, the main
  jobs, and the rules.
- `skills/webhooks-cc/references/`: one short file per topic, read when
  needed: `testing.md` (payload types, signed sends, debugging),
  `responses.md` (mock responses, rules, placeholders), `email.md` (codes and
  links, fields, layouts, AI setup, inbound handlers, domains),
  `forwarding.md` (destinations, Sheets, file drops), `tunnels.md` (tunnels,
  live tunnels, preview links), `cli.md` (`whk` for agents),
  `account.md` (plans, teams, keys), `sdk-tests.md` (Vitest, Jest,
  Playwright, pytest and Go recipes).
- `.mcp.json`: starts `@webhooks-cc/mcp` with the key you entered.

The skill was called `webhook-testing` before version 2.0.0 of this plugin.

Documentation: [webhooks.cc/docs/mcp/skills](https://webhooks.cc/docs/mcp/skills).
MIT licensed.
