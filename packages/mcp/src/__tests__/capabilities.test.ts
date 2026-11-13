import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { WebhooksCC } from "@webhooks-cc/sdk";
import { registerSandboxTools } from "../sandbox-tools";
import { LOCAL_ONLY_TOOLS, registerTools } from "../tools";

// capabilities.json at the repository root names, for each capability, the
// MCP tools that reach it ("sandbox/<tool>" for the tools a server without
// an account offers), and mcpHosted says why the hosted server lacks one the
// local server has. The SDK's capabilities test checks the rest.

const repo = join(__dirname, "..", "..", "..", "..");
const manifest = JSON.parse(readFileSync(join(repo, "capabilities.json"), "utf-8")) as {
  capabilities: { id: string; mcp: string[] | string; mcpHosted?: string }[];
  local: { mcp: Record<string, string> };
};

function toolNames(register: (server: McpServer) => void): string[] {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const spy = vi.spyOn(server, "tool");
  register(server);
  return spy.mock.calls.map((call) => call[0] as string);
}

const tools = new Set([
  ...toolNames((server) => registerTools(server, {} as WebhooksCC)),
  ...toolNames((server) => registerSandboxTools(server, {})).map((name) => `sandbox/${name}`),
]);

const listed = [
  ...manifest.capabilities.flatMap((c) =>
    Array.isArray(c.mcp) ? c.mcp.map((tool) => ({ id: c.id, tool })) : []
  ),
  ...Object.keys(manifest.local.mcp).map((tool) => ({ id: "local.mcp", tool })),
];

describe("capabilities.json and the MCP server", () => {
  it("names tools the server has", () => {
    for (const { id, tool } of listed) {
      expect(tools.has(tool), `${id}: the MCP server has no tool ${tool}`).toBe(true);
    }
  });

  it("lists every tool", () => {
    const names = new Set(listed.map(({ tool }) => tool));
    const missing = [...tools].filter((tool) => !names.has(tool));
    expect(missing, "add these tools to a capability in capabilities.json").toEqual([]);
  });

  it("says where the hosted server lacks a tool", () => {
    for (const c of manifest.capabilities) {
      const localOnly = Array.isArray(c.mcp) && c.mcp.some((tool) => LOCAL_ONLY_TOOLS.has(tool));
      expect(
        Boolean(c.mcpHosted),
        localOnly
          ? `${c.id}: the hosted MCP server lacks some of its tools; say why in mcpHosted`
          : `${c.id}: mcpHosted, but the hosted MCP server has all its tools`
      ).toBe(localOnly);
    }
  });
});
