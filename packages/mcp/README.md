# @webhooks-cc/mcp

MCP server for [webhooks.cc](https://webhooks.cc). It gives coding agents direct access to webhook testing workflows: create endpoints, send signed test webhooks, inspect captures, compare attempts, verify signatures, and read recent webhook context through MCP resources.

It works with Claude Code, Cursor, VS Code, Codex, Windsurf, and Claude Desktop.

## Install

The server reads `WHK_API_KEY` from the environment. It also supports:

- `WHK_BASE_URL` for a custom API base URL
- `WHK_WEBHOOK_URL` for a custom receiver base URL

### One-click

- **Cursor**: [Add to Cursor](https://cursor.com/en/install-mcp?name=webhooks-cc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB3ZWJob29rcy1jYy9tY3AiXSwiZW52Ijp7IldIS19BUElfS0VZIjoid2hjY18uLi4ifX0=)
- **VS Code**: [Add to VS Code](https://insiders.vscode.dev/redirect/mcp/install?name=webhooks-cc&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40webhooks-cc%2Fmcp%22%5D%2C%22env%22%3A%7B%22WHK_API_KEY%22%3A%22%24%7Binput%3Awhk_api_key%7D%22%7D%7D&inputs=%5B%7B%22id%22%3A%22whk_api_key%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22webhooks.cc%20API%20key%20%28get%20yours%20at%20webhooks.cc%2Faccount%29%22%2C%22password%22%3Atrue%7D%5D)

### CLI

```bash
# Claude Code
claude mcp add -s user --transport stdio webhooks-cc -e WHK_API_KEY=whcc_... -- npx -y @webhooks-cc/mcp

# OpenAI Codex
codex mcp add webhooks-cc -e WHK_API_KEY=whcc_... -- npx -y @webhooks-cc/mcp

# Cursor
npx @webhooks-cc/mcp setup cursor --api-key whcc_...

# VS Code
npx @webhooks-cc/mcp setup vscode --api-key whcc_...

# Windsurf
npx @webhooks-cc/mcp setup windsurf --api-key whcc_...

# Claude Desktop
npx @webhooks-cc/mcp setup claude-desktop --api-key whcc_...
```

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

Get your API key at [webhooks.cc/account](https://webhooks.cc/account).

## What it exposes

The server exposes `25` tools, `3` prompts, and `3` resource surfaces.

### Endpoint tools

- `create_endpoint`
- `list_endpoints`
- `get_endpoint`
- `update_endpoint`
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
- `extract_from_request`
- `verify_signature`
- `clear_requests`

### Send and test tools

- `send_webhook`
- `send_to`
- `preview_webhook`
- `test_webhook_flow`

### Discovery and account tools

- `list_provider_templates`
- `get_usage`
- `describe`

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
- `standard-webhooks`

Signature verification also supports:

- `discord`

Use `list_provider_templates` to inspect templates, default events, signature headers, and signing requirements from the agent.

## Example workflows

Typical agent flows:

- Create an ephemeral endpoint, send a provider-signed webhook, and wait for capture
- Search retained requests across endpoints with full-text filters
- Compare two webhook attempts and extract only the JSON fields you care about
- Verify a captured signature against a known secret
- Run `test_webhook_flow` to create, send, capture, verify, replay, and clean up in one tool call

## Programmatic use

The package also exports `createServer()`, `registerTools()`, `registerPrompts()`, and `registerResources()` if you want to embed the server yourself.

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
