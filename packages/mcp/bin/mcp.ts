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
  WHK_API_KEY        Your webhooks.cc API key (required)
  WHK_WEBHOOK_URL    Custom webhook receiver URL (optional)
  WHK_BASE_URL       Custom API base URL (optional)

Setup:
  npx @webhooks-cc/mcp setup claude-code --api-key whcc_...
  npx @webhooks-cc/mcp setup cursor --api-key whcc_...
  npx @webhooks-cc/mcp setup vscode --api-key whcc_...
  npx @webhooks-cc/mcp setup codex --api-key whcc_...
  npx @webhooks-cc/mcp setup windsurf --api-key whcc_...
  npx @webhooks-cc/mcp setup claude-desktop --api-key whcc_...

Get your API key at https://webhooks.cc/account
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
