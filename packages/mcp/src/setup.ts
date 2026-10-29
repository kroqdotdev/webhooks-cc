import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname, posix, win32 } from "path";
import { execFileSync } from "child_process";
import { homedir, platform } from "os";

const TOOLS = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "vscode",
  "codex",
  "devin",
  "windsurf",
] as const;
type Tool = (typeof TOOLS)[number];

const API_KEY_REGEX = /^whcc_[a-zA-Z0-9_-]+$/;

function validateApiKeyFormat(key: string): void {
  if (!API_KEY_REGEX.test(key)) {
    console.error("Error: Invalid API key format. Keys must start with 'whcc_' and contain only");
    console.error("alphanumeric characters, hyphens, and underscores.");
    process.exit(1);
  }
}

/** Without an API key the server starts in the keyless agent sandbox. */
function mcpServerConfig(apiKey: string | null) {
  return {
    command: "npx",
    args: ["-y", "@webhooks-cc/mcp"],
    ...(apiKey ? { env: { WHK_API_KEY: apiKey } } : {}),
  };
}

/** VS Code's mcp.json names its servers under `servers`, with a transport type. */
function vscodeServerConfig(apiKey: string | null) {
  return { type: "stdio", ...mcpServerConfig(apiKey) };
}

function resolveApiKey(flags: Record<string, string>): string | null {
  return flags["api-key"] ?? process.env.WHK_API_KEY ?? null;
}

/**
 * Adds the server to a JSON config file and reports whether it wrote. A file
 * that is not plain JSON is backed up and replaced, unless `onInvalid` is
 * "keep" (for formats that allow comments), which leaves it alone.
 */
function mergeJsonConfig(
  filePath: string,
  serverName: string,
  serverConfig: object,
  key: "mcpServers" | "servers" = "mcpServers",
  onInvalid: "replace" | "keep" = "replace"
): boolean {
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      if (onInvalid === "keep") return false;
      console.warn(`Warning: ${filePath} contains invalid JSON and will be overwritten.`);
      console.warn(`A backup has been saved to ${filePath}.bak`);
      copyFileSync(filePath, `${filePath}.bak`);
    }
  }

  const servers = (existing[key] ?? {}) as Record<string, unknown>;
  servers[serverName] = serverConfig;
  existing[key] = servers;

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n");
  return true;
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

function setupClaudeCode(apiKey: string | null): void {
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
        ...(apiKey ? ["-e", `WHK_API_KEY=${apiKey}`] : []),
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
      `  claude mcp add -s user --transport stdio webhooks-cc${apiKey ? " -e WHK_API_KEY=<your-key>" : ""} -- npx -y @webhooks-cc/mcp`
    );
    process.exit(1);
  }
}

function setupClaudeDesktop(apiKey: string | null): void {
  const configPath = getClaudeDesktopConfigPath();
  mergeJsonConfig(configPath, "webhooks-cc", mcpServerConfig(apiKey));
  console.log(`Done! Config written to ${configPath}`);
  console.log("Restart Claude Desktop for changes to take effect.");
}

function setupCursor(apiKey: string | null): void {
  const configPath = join(process.cwd(), ".cursor", "mcp.json");
  mergeJsonConfig(configPath, "webhooks-cc", mcpServerConfig(apiKey));
  console.log(`Done! Config written to ${configPath}`);
  console.log("Restart Cursor or reload the window for changes to take effect.");
}

function setupVSCode(apiKey: string | null): void {
  const configPath = join(process.cwd(), ".vscode", "mcp.json");
  mergeJsonConfig(configPath, "webhooks-cc", vscodeServerConfig(apiKey), "servers");
  console.log(`Done! Config written to ${configPath}`);
  console.log("Reload VS Code window for changes to take effect.");
}

function setupCodex(apiKey: string | null): void {
  try {
    execFileSync(
      "codex",
      [
        "mcp",
        "add",
        "webhooks-cc",
        ...(apiKey ? ["-e", `WHK_API_KEY=${apiKey}`] : []),
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
[mcp_servers.webhooks-cc]
command = "npx"
args = ["-y", "@webhooks-cc/mcp"]
${
  apiKey
    ? `
[mcp_servers.webhooks-cc.env]
WHK_API_KEY = "<your-key>"
`
    : ""
}`);
    process.exit(1);
  }
}

/**
 * The user-level MCP config of Devin Desktop (Windsurf until its 2026 rename)
 * and the Devin CLI: devin/mcp_config.json in the XDG config directory, on
 * macOS too, or in %APPDATA% on Windows.
 */
export function devinMcpConfigPath(
  os: string = platform(),
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env
): string {
  if (os === "win32") {
    const base = env.APPDATA || win32.join(home, "AppData", "Roaming");
    return win32.join(base, "devin", "mcp_config.json");
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".config");
  return posix.join(base, "devin", "mcp_config.json");
}

/** Where Windsurf builds from before the rename read their MCP servers. */
export function legacyWindsurfConfigPath(home: string = homedir()): string {
  return join(home, ".codeium", "windsurf", "mcp_config.json");
}

// Devin's config files may hold comments, which JSON.parse rejects, so a file
// that does not parse is left as it is rather than replaced.
function setupDevin(apiKey: string | null): void {
  const config = mcpServerConfig(apiKey);
  const configPath = devinMcpConfigPath();
  if (!mergeJsonConfig(configPath, "webhooks-cc", config, "mcpServers", "keep")) {
    console.error(
      `${configPath} is not plain JSON (it may hold comments), so it was left as it is.`
    );
    console.error(`Add this under "mcpServers" yourself:\n`);
    const entry = mcpServerConfig(apiKey ? "<your-key>" : null);
    console.error(`"webhooks-cc": ${JSON.stringify(entry, null, 2)}`);
    process.exit(1);
  }
  console.log(`Done! Config written to ${configPath}`);

  // Only update the old file where Windsurf is installed; never create it.
  const legacyPath = legacyWindsurfConfigPath();
  if (existsSync(dirname(legacyPath))) {
    if (mergeJsonConfig(legacyPath, "webhooks-cc", config, "mcpServers", "keep")) {
      console.log(`Also written to ${legacyPath}, for Windsurf from before the rename.`);
    } else {
      console.warn(`Left ${legacyPath} as it is: it is not plain JSON.`);
    }
  }
  console.log("Restart Devin Desktop (or Windsurf) for changes to take effect.");
}

function printUsage(): void {
  console.log(`
@webhooks-cc/mcp setup — Configure the MCP server for your AI tool

Usage:
  npx @webhooks-cc/mcp setup <tool> [--api-key <key>]

Without a key the server starts in the keyless agent sandbox; your agent can
connect your account later (connect_account), and the connection is saved.

Tools:
  claude-code      Claude Code CLI (runs 'claude mcp add')
  claude-desktop   Claude Desktop app
  cursor           Cursor editor (writes .cursor/mcp.json)
  vscode           VS Code Copilot (writes .vscode/mcp.json)
  codex            OpenAI Codex CLI (runs 'codex mcp add')
  devin            Devin Desktop (formerly Windsurf) and the Devin CLI
  windsurf         The same as devin

Options:
  --api-key <key>  Your webhooks.cc API key (or set WHK_API_KEY env var); optional

Examples:
  npx @webhooks-cc/mcp setup claude-code
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
  if (apiKey) validateApiKeyFormat(apiKey);

  console.log(`Setting up webhooks-cc MCP server for ${tool}...\n`);
  if (!apiKey) {
    console.log("No API key: the server starts in the keyless agent sandbox. Your agent can");
    console.log("connect your account later with connect_account; the connection is saved.\n");
  }

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
    case "devin":
    case "windsurf":
      setupDevin(apiKey);
      break;
  }
}
