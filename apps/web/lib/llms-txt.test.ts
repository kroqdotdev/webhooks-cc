import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// public/llms.txt and llms-full.txt are static files, so nothing else keeps
// them leading with the remote MCP server the way /auth.md does.
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "../public", file), "utf8");

const REMOTE = "claude mcp add -s user --transport http webhooks-cc https://webhooks.cc/mcp";
const LOCAL = "claude mcp add webhooks-cc -- npx -y @webhooks-cc/mcp";

describe("llms.txt", () => {
  it("starts agents on the remote MCP server, before the local server", () => {
    const llms = read("llms.txt");
    const start = llms.slice(llms.indexOf("## For AI agents: start here"));
    expect(start.indexOf(REMOTE)).toBeGreaterThan(-1);
    expect(start.indexOf(REMOTE)).toBeLessThan(start.indexOf(LOCAL));
  });
});

describe("llms-full.txt", () => {
  it("lists the remote MCP server first in the MCP installation", () => {
    const full = read("llms-full.txt");
    const install = full.slice(full.indexOf("## MCP Server Reference"));
    expect(install.indexOf("**Remote server (recommended).**")).toBeGreaterThan(-1);
    expect(install.indexOf("**Remote server (recommended).**")).toBeLessThan(
      install.indexOf("**Local server.**")
    );
    expect(install.indexOf("claude mcp add -s user --transport http")).toBeLessThan(
      install.indexOf("claude mcp add webhooks-cc -- npx -y @webhooks-cc/mcp")
    );
  });
});
