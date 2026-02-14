import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { execFileSync } from "child_process";
import { homedir, platform } from "os";

const TOOLS = ["claude-code", "claude-desktop", "cursor", "vscode", "codex", "windsurf"] as const;
type Tool = (typeof TOOLS)[number];

const API_KEY_REGEX = /^whcc_[a-zA-Z0-9_-]+$/;

function validateApiKeyFormat(key: string): void {
  if (!API_KEY_REGEX.test(key)) {
    console.error("Error: Invalid API key format. Keys must start with 'whcc_' and contain only");
    console.error("alphanumeric characters, hyphens, and underscores.");
    process.exit(1);
  }
}

function mcpServerConfig(apiKey: string) {
  return {
    command: "npx",
    args: ["-y", "@webhooks-cc/mcp"],
    env: { WHK_API_KEY: apiKey },
  };
}

function resolveApiKey(flags: Record<string, string>): string | null {
  return flags["api-key"] ?? process.env.WHK_API_KEY ?? null;
}

function mergeJsonConfig(filePath: string, serverName: string, serverConfig: object): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      console.warn(`Warning: ${filePath} contains invalid JSON and will be overwritten.`);
      console.warn(`A backup has been saved to ${filePath}.bak`);
      copyFileSync(filePath, `${filePath}.bak`);
    }
  }

  const mcpServers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  mcpServers[serverName] = serverConfig;
  existing.mcpServers = mcpServers;

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n");
}

function getClaudeDesktopConfigPath(): string {
  const os = platform();
  if (os === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  }
  if (os === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json"
    );
  }
  // Linux
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function setupClaudeCode(apiKey: string): void {
  try {
    execFileSync(
      "claude",
      [
        "mcp",
        "add",
        "-s",
        "user",
        "--transport",
        "stdio",
        "webhooks-cc",
        "-e",
        `WHK_API_KEY=${apiKey}`,
        "--",
        "npx",
        "-y",
        "@webhooks-cc/mcp",
      ],
      { stdio: "inherit" }
    );
    console.log("\nDone! webhooks-cc MCP server added to Claude Code (user scope).");
    console.log("It will be available in all your Claude Code sessions.");
  } catch {
    console.error("\nFailed to run 'claude mcp add'. Is Claude Code CLI installed?");
    console.error("Install it: npm install -g @anthropic-ai/claude-code");
    console.error("\nManual alternative — run this command:");
    console.error(
      `  claude mcp add -s user --transport stdio webhooks-cc -e WHK_API_KEY=<your-key> -- npx -y @webhooks-cc/mcp`
    );
    process.exit(1);
  }
}

function setupClaudeDesktop(apiKey: string): void {
  const configPath = getClaudeDesktopConfigPath();
  mergeJsonConfig(configPath, "webhooks-cc", mcpServerConfig(apiKey));
  console.log(`Done! Config written to ${configPath}`);
  console.log("Restart Claude Desktop for changes to take effect.");
}

function setupCursor(apiKey: string): void {
  const configPath = join(process.cwd(), ".cursor", "mcp.json");
  mergeJsonConfig(configPath, "webhooks-cc", mcpServerConfig(apiKey));
  console.log(`Done! Config written to ${configPath}`);
  console.log("Restart Cursor or reload the window for changes to take effect.");
}

function setupVSCode(apiKey: string): void {
  const configPath = join(process.cwd(), ".vscode", "mcp.json");
  mergeJsonConfig(configPath, "webhooks-cc", mcpServerConfig(apiKey));
  console.log(`Done! Config written to ${configPath}`);
  console.log("Reload VS Code window for changes to take effect.");
}

function setupCodex(apiKey: string): void {
  try {
    execFileSync(
      "codex",
      [
        "mcp",
        "add",
        "webhooks-cc",
        "-e",
        `WHK_API_KEY=${apiKey}`,
        "--",
        "npx",
        "-y",
        "@webhooks-cc/mcp",
      ],
      { stdio: "inherit" }
    );
    console.log("\nDone! webhooks-cc MCP server added to Codex.");
  } catch {
    console.error("\nFailed to run 'codex mcp add'. Is OpenAI Codex CLI installed?");
    console.error("\nManual alternative — add to ~/.codex/config.toml:");
    console.error(`
[mcp.webhooks-cc]
command = "npx"
args = ["-y", "@webhooks-cc/mcp"]

[mcp.webhooks-cc.env]
WHK_API_KEY = "<your-key>"
`);
    process.exit(1);
  }
}

function setupWindsurf(apiKey: string): void {
  const configPath = join(homedir(), ".codeium", "windsurf", "mcp_config.json");
  mergeJsonConfig(configPath, "webhooks-cc", mcpServerConfig(apiKey));
  console.log(`Done! Config written to ${configPath}`);
  console.log("Restart Windsurf for changes to take effect.");
}

function printUsage(): void {
  console.log(`
@webhooks-cc/mcp setup — Configure the MCP server for your AI tool

Usage:
  npx @webhooks-cc/mcp setup <tool> [--api-key <key>]

Tools:
  claude-code      Claude Code CLI (runs 'claude mcp add')
  claude-desktop   Claude Desktop app
  cursor           Cursor editor (writes .cursor/mcp.json)
  vscode           VS Code Copilot (writes .vscode/mcp.json)
  codex            OpenAI Codex CLI (runs 'codex mcp add')
  windsurf         Windsurf editor

Options:
  --api-key <key>  Your webhooks.cc API key (or set WHK_API_KEY env var)

Examples:
  npx @webhooks-cc/mcp setup claude-code --api-key whcc_abc123
  WHK_API_KEY=whcc_abc123 npx @webhooks-cc/mcp setup cursor
  npx @webhooks-cc/mcp setup vscode --api-key whcc_abc123
`);
}

export function runSetup(args: string[]): void {
  // Parse flags
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api-key" && i + 1 < args.length) {
      flags["api-key"] = args[++i];
    } else if (args[i].startsWith("--api-key=")) {
      flags["api-key"] = args[i].slice("--api-key=".length);
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i]);
    }
  }

  const tool = positional[0] as Tool | undefined;

  if (!tool || !TOOLS.includes(tool)) {
    printUsage();
    if (tool) {
      console.error(`Unknown tool: "${tool}"\n`);
    }
    process.exit(tool ? 1 : 0);
  }

  const apiKey = resolveApiKey(flags);
  if (!apiKey) {
    console.error("Error: API key required. Pass --api-key or set WHK_API_KEY env var.");
    console.error("Get your API key at https://webhooks.cc/account\n");
    process.exit(1);
  }

  validateApiKeyFormat(apiKey);

  console.log(`Setting up webhooks-cc MCP server for ${tool}...\n`);

  switch (tool) {
    case "claude-code":
      setupClaudeCode(apiKey);
      break;
    case "claude-desktop":
      setupClaudeDesktop(apiKey);
      break;
    case "cursor":
      setupCursor(apiKey);
      break;
    case "vscode":
      setupVSCode(apiKey);
      break;
    case "codex":
      setupCodex(apiKey);
      break;
    case "windsurf":
      setupWindsurf(apiKey);
      break;
  }
}
