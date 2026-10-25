# webhooks.cc for coding agents

A skill that teaches coding agents to test webhook handlers and email flows with
real, correctly signed traffic, instead of guessing payloads or switching off
signature checks. In Claude Code it comes as a plugin together with the
[webhooks.cc MCP server](https://www.npmjs.com/package/@webhooks-cc/mcp).

With it, asking an agent to "build the Stripe webhook handler and test it" makes
the agent capture real deliveries, generate types from them, send signed
payloads to the local route, and check the result.

## Install

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
[webhooks.cc/account/api-keys](https://webhooks.cc/account/api-keys).

### Cursor, Codex, GitHub Copilot, Gemini CLI, OpenCode and others

Install the skill with the [skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add kroqdotdev/webhooks-cc
```

Then add the MCP server to your agent:

```bash
npx @webhooks-cc/mcp setup cursor --api-key whcc_...
```

`setup` also takes `claude-code`, `claude-desktop`, `vscode`, `codex` and
`windsurf`.

To install by hand, copy [`skills/webhook-testing`](skills/webhook-testing) into
your agent's skills folder, for example `.agents/skills/` or `.claude/skills/`.

### Any agent that reads AGENTS.md

Add this to the project's `AGENTS.md` (or `CLAUDE.md`):

```markdown
## Webhooks

Test webhook handlers with webhooks.cc, never by disabling signature checks:
send provider-signed payloads to the local route with the webhooks-cc MCP tool
`send_to` (or `sendTo` from `@webhooks-cc/sdk` in tests), and generate payload
types from captured requests with `generate_payload_schema`.
```

## What is inside

- `skills/webhook-testing/SKILL.md`: when to reach for webhooks.cc and the
  workflows: learn a payload, test a local handler, write CI tests, check the
  app's own webhooks, simulate failures and callbacks, read signup emails,
  forward captures to servers, Slack, Discord or Zapier with filters and your
  own JSON, debug deliveries.
- `skills/webhook-testing/references/sdk-tests.md`: Vitest, Jest and Playwright
  recipes with `@webhooks-cc/sdk`.
- `.mcp.json`: starts `@webhooks-cc/mcp` with the key you entered.

Documentation: [webhooks.cc/docs/mcp/skills](https://webhooks.cc/docs/mcp/skills).
MIT licensed.
