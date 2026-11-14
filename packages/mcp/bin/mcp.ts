import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../src/index";
import { runSetup } from "../src/setup";

const args = process.argv.slice(2);
const command = args[0];

if (command === "setup") {
  runSetup(args.slice(1));
} else if (command === "--help" || command === "-h") {
  console.log(`
@webhooks-cc/mcp: MCP server for webhooks.cc

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
  WHK_MCP_TOOLS      Tool groups to list: all, or core plus any of forwarding,
                     layouts, extras, teams, account, domains, sheets, names
                     (default: core, and all for Claude Code, Codex and
                     ChatGPT; enable_tools loads more during a session)
  WHK_MCP_READ_ONLY  1 to list only the tools that change nothing

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
  // Default: serve stdio, to 2026-07-28 clients and to clients that still
  // open with initialize: one server per connection, from the factory.
  serveStdio(() => createServer(), {
    // Out-of-band reports only, never what was sent; stdout is the protocol.
    onerror: (error) => console.error(`webhooks-cc-mcp: ${error.message}`),
  });
}
