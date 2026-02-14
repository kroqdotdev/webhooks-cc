# @webhooks-cc/mcp

MCP server for [webhooks.cc](https://webhooks.cc). Connects AI coding agents to webhook endpoints — create, inspect, test, and replay webhooks through natural language.

Works with Claude Code, Cursor, VS Code, Codex, Windsurf, and Claude Desktop.

## Install

### One-click

- **Cursor**: [Add to Cursor](https://cursor.com/en/install-mcp?name=webhooks-cc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB3ZWJob29rcy1jYy9tY3AiXSwiZW52Ijp7IldIS19BUElfS0VZIjoid2hjY18uLi4ifX0=) (paste your API key after install)
- **VS Code**: [Add to VS Code](https://insiders.vscode.dev/redirect/mcp/install?name=webhooks-cc&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40webhooks-cc%2Fmcp%22%5D%2C%22env%22%3A%7B%22WHK_API_KEY%22%3A%22%24%7Binput%3Awhk_api_key%7D%22%7D%7D&inputs=%5B%7B%22id%22%3A%22whk_api_key%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22webhooks.cc%20API%20key%20%28get%20yours%20at%20webhooks.cc%2Faccount%29%22%2C%22password%22%3Atrue%7D%5D) (prompts for your key)

### CLI

```bash
# Claude Code
claude mcp add -s user --transport stdio webhooks-cc -e WHK_API_KEY=whcc_... -- npx -y @webhooks-cc/mcp

# Cursor
npx @webhooks-cc/mcp setup cursor --api-key whcc_...

# VS Code
npx @webhooks-cc/mcp setup vscode --api-key whcc_...

# OpenAI Codex
codex mcp add webhooks-cc -e WHK_API_KEY=whcc_... -- npx -y @webhooks-cc/mcp

# Windsurf
npx @webhooks-cc/mcp setup windsurf --api-key whcc_...

# Claude Desktop
npx @webhooks-cc/mcp setup claude-desktop --api-key whcc_...
```

### Manual JSON config

For any tool that reads an MCP config file:

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

## Tools

The MCP server exposes 11 tools:

| Tool               | Description                               |
| ------------------ | ----------------------------------------- |
| `create_endpoint`  | Create a new webhook endpoint             |
| `list_endpoints`   | List all your endpoints                   |
| `get_endpoint`     | Get details for an endpoint by slug       |
| `update_endpoint`  | Update an endpoint name or mock response  |
| `delete_endpoint`  | Delete an endpoint and its requests       |
| `list_requests`    | List captured requests for an endpoint    |
| `get_request`      | Get full details of a captured request    |
| `send_webhook`     | Send a test webhook to an endpoint        |
| `wait_for_request` | Wait for an incoming request (polling)    |
| `replay_request`   | Replay a captured request to a target URL |
| `describe`         | Describe all available SDK operations     |

## Example conversation

```
You: "Create a webhook endpoint for testing Stripe"
Agent: Created endpoint "stripe-test" at https://go.webhooks.cc/w/abc123

You: "Set it to return 201 with {"received": true}"
Agent: Updated mock response for stripe-test

You: "Send a test POST with a checkout.session.completed event"
Agent: Sent POST to stripe-test with event payload

You: "Show me what was captured"
Agent: 1 request captured:
  POST /w/abc123 — {"event": "checkout.session.completed", ...}

You: "Replay that to my local server"
Agent: Replayed to http://localhost:3000/webhooks — got 200 OK
```

## Documentation

Full setup guide with interactive API key filling: [webhooks.cc/docs/mcp](https://webhooks.cc/docs/mcp)

## License

MIT
