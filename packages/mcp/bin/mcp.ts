import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/index";
import { runSetup } from "../src/setup";

const args = process.argv.slice(2);
const command = args[0];

if (command === "setup") {
  runSetup(args.slice(1));
} else if (command === "--help" || command === "-h") {
  console.log(`
@webhooks-cc/mcp — MCP server for webhooks.cc

Usage:
  npx @webhooks-cc/mcp                    Start stdio MCP server
  npx @webhooks-cc/mcp setup <tool>       Configure for an AI tool
  npx @webhooks-cc/mcp --help             Show this help

Environment:
  WHK_API_KEY        Your webhooks.cc API key (optional; without it the server
                     starts connected to the account your agent was connected
                     to before, or in the keyless agent sandbox)
  WHK_AGENT_FILE     Where the sandbox and the connection are saved (default:
                     ~/.config/whk/agent.json, shared with the whk CLI and SDKs)
  WHK_WEBHOOK_URL    Custom webhook receiver URL (optional)
  WHK_BASE_URL       Custom API base URL (optional)

Setup:
  npx @webhooks-cc/mcp setup claude-code
  npx @webhooks-cc/mcp setup cursor
  npx @webhooks-cc/mcp setup vscode
  npx @webhooks-cc/mcp setup codex
  npx @webhooks-cc/mcp setup devin
  npx @webhooks-cc/mcp setup claude-desktop
  (add --api-key whcc_... to start with your account's tools)

Hosted agents (claude.ai, ChatGPT): add https://webhooks.cc/mcp as a remote
MCP server instead; you approve it once in your browser.

Get your API key at https://webhooks.cc/account/api-keys
`);
} else if (command && command !== "--") {
  console.error(`Unknown command: "${command}". Run with --help for usage.`);
  process.exit(1);
} else {
  // Default: start stdio server
  const server = createServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((error) => {
    console.error("Fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
