import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import type { WebhooksCC } from "@webhooks-cc/sdk";
import {
  clientLoadsEverything,
  ENABLE_TOOLS,
  parseToolGroups,
  TOOL_CATALOG,
  TOOL_GROUP_NAMES,
  toolAnnotations,
  toolTitle,
} from "../catalog";
import { asToolServer } from "../local-tools";
import { registerSandboxTools } from "../sandbox-tools";
import { registerTools, type ToolServer } from "../tools";

function registered(options: Parameters<typeof registerTools>[2] = {}) {
  const names: string[] = [];
  const server: ToolServer = {
    tool(name) {
      names.push(name);
      return { remove() {} };
    },
  };
  registerTools(server, {} as WebhooksCC, options);
  return names;
}

describe("the tool catalog", () => {
  const all = registered();

  it("has an entry for every tool, and names only tools that exist", () => {
    expect(all.length).toBeGreaterThan(0);
    expect([...all].sort()).toEqual(Object.keys(TOOL_CATALOG).sort());
  });

  it("keeps the core, with enable_tools, within Cursor's 40 tools", () => {
    const core = registered({ groups: new Set(["core"]) });
    expect(core.length + 1).toBeLessThanOrEqual(40);
    expect(core).not.toContain(ENABLE_TOOLS);
    expect(TOOL_CATALOG[ENABLE_TOOLS]).toBeUndefined();
  });

  it("registers each group's tools and nothing else", () => {
    for (const group of TOOL_GROUP_NAMES) {
      const names = registered({ groups: new Set([group]) });
      expect(names.length, group).toBeGreaterThan(0);
      for (const name of names) expect(TOOL_CATALOG[name].group).toBe(group);
    }
  });

  it("registers only read-only tools in read-only mode", () => {
    const names = registered({ readOnly: true });
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(toolAnnotations(name).readOnlyHint, name).toBe(true);
  });

  it("never calls a read destructive", () => {
    for (const name of Object.keys(TOOL_CATALOG)) {
      const hints = toolAnnotations(name);
      if (hints.readOnlyHint) {
        expect(hints.destructiveHint, name).toBe(false);
        expect(hints.idempotentHint, name).toBe(true);
      }
    }
  });

  it("annotates every sandbox tool", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const spy = vi.spyOn(server, "registerTool");
    registerSandboxTools(server, { credentialsFile: false, tools: "core" });
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const [name, config] of spy.mock.calls) {
      expect(config.annotations, name).toMatchObject({ readOnlyHint: expect.any(Boolean) });
      expect(config.title, name).toBe(toolTitle(name));
    }
  });

  it("passes annotations through the v2 adapter", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const spy = vi.spyOn(server, "registerTool");
    registerTools(asToolServer(server), {} as WebhooksCC, { groups: new Set(["account"]) });
    const key = spy.mock.calls.find(([name]) => name === "revoke_api_key")!;
    expect(key[1]).toMatchObject({
      title: "Revoke API key",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    });
  });
});

describe("tool group settings", () => {
  it("parses settings", () => {
    expect(parseToolGroups(undefined)).toBeNull();
    expect(parseToolGroups("  ")).toBeNull();
    expect([...parseToolGroups("all")!.groups].sort()).toEqual([...TOOL_GROUP_NAMES].sort());
    expect(parseToolGroups("teams+domains")).toEqual({
      groups: new Set(["core", "teams", "domains"]),
      unknown: [],
    });
    expect(parseToolGroups("Teams, nope")!.unknown).toEqual(["nope"]);
  });

  it("gives every group to clients that take long lists, and core to the rest", () => {
    for (const name of ["claude-code", "claude-ai", "codex-mcp-client", "openai-mcp"]) {
      expect(clientLoadsEverything(name), name).toBe(true);
    }
    for (const name of ["cursor-vscode", "Visual Studio Code", "windsurf-client", undefined]) {
      expect(clientLoadsEverything(name), String(name)).toBe(false);
    }
  });
});
