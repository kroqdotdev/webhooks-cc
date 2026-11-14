import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ENABLE_TOOLS, TOOL_CATALOG, TOOL_GROUP_NAMES, type ToolGroup } from "../catalog";
import { createServer, type CreateServerOptions } from "../index";

// The local server's tool groups, served the way the bin serves them
// (serveStdio), to a 2025-era client that opens with initialize (the v1
// SDK's Client) and to a 2026-07-28 client that names itself in _meta.

const SERVER = { apiKey: "whcc_test", baseUrl: "http://127.0.0.1:9" };
const ALL = Object.keys(TOOL_CATALOG);
const inGroups = (...groups: ToolGroup[]) =>
  ALL.filter((name) => groups.includes(TOOL_CATALOG[name].group));
const CORE = inGroups("core");

const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
  vi.restoreAllMocks();
});

async function legacyClient(name: string, options: CreateServerOptions = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  open.push(serveStdio(() => createServer({ ...SERVER, ...options }), { transport: serverSide }));
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes += 1;
  });
  await client.connect(clientSide as never);
  open.push(client);
  const tools = async () => (await client.listTools()).tools;
  const names = async () => (await tools()).map((tool) => tool.name).sort();
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name: tool, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
  };
  // Let a debounced list_changed go out before counting.
  const settled = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return changes;
  };
  return { client, tools, names, call, settled };
}

const sorted = (names: string[]) => [...names].sort();

describe("tool groups on the local server", () => {
  it("lists the core tools and enable_tools for a client it does not know", async () => {
    const { names, tools, settled } = await legacyClient("cursor-vscode");
    expect(await names()).toEqual(sorted([...CORE, ENABLE_TOOLS]));
    // Cursor stops at about 40 tools across all servers.
    expect(CORE.length + 1).toBeLessThanOrEqual(40);
    expect(await settled()).toBe(0);

    for (const tool of await tools()) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      expect(tool.title, tool.name).toBeTruthy();
    }
    const enable = (await tools()).find((tool) => tool.name === ENABLE_TOOLS)!;
    expect(enable.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const group of TOOL_GROUP_NAMES.filter((g) => g !== "core")) {
      expect(enable.description).toContain(`- ${group}: `);
    }
  });

  it("loads every group for Claude Code once it has initialized, with one list_changed", async () => {
    const { names, settled } = await legacyClient("claude-code");
    expect(await names()).toEqual(sorted(ALL));
    expect(await settled()).toBe(1);
  });

  it("takes the groups from WHK_MCP_TOOLS, whatever the client", async () => {
    vi.stubEnv("WHK_MCP_TOOLS", "all");
    try {
      const all = await legacyClient("cursor-vscode");
      expect(await all.names()).toEqual(sorted(ALL));
      expect(await all.settled()).toBe(0);

      vi.stubEnv("WHK_MCP_TOOLS", "core,teams");
      const some = await legacyClient("claude-code");
      expect(await some.names()).toEqual(sorted([...inGroups("core", "teams"), ENABLE_TOOLS]));
      expect(await some.settled()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("warns on stderr about unknown group names and keeps the rest", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log");
    const { names } = await legacyClient("claude-code", { tools: "teams,bogus" });
    expect(await names()).toEqual(sorted([...inGroups("core", "teams"), ENABLE_TOOLS]));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown tool groups"));
    expect(warn.mock.calls.flat().join(" ")).toContain("bogus");
    expect(log).not.toHaveBeenCalled();
  });

  it("lists only the tools that change nothing in read-only mode", async () => {
    vi.stubEnv("WHK_MCP_READ_ONLY", "1");
    try {
      const { tools } = await legacyClient("claude-code");
      const listed = await tools();
      const readOnly = ALL.filter((name) => TOOL_CATALOG[name].readOnly === true);
      expect(listed.map((tool) => tool.name).sort()).toEqual(sorted(readOnly));
      for (const tool of listed) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);

      // enable_tools stays (it only changes this session's list) and loads
      // only a group's read-only tools.
      const narrow = await legacyClient("cursor-vscode", { readOnly: true });
      const before = await narrow.names();
      expect(before).toContain(ENABLE_TOOLS);
      const loaded = await narrow.call(ENABLE_TOOLS, { groups: ["teams"] });
      expect(loaded.body.added.teams).toEqual(
        inGroups("teams").filter((name) => TOOL_CATALOG[name].readOnly === true)
      );
      expect(loaded.body.readOnly).toBe(true);
      const after = await narrow.names();
      expect(after).toContain("list_teams");
      expect(after).not.toContain("create_team");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("enable_tools loads a group once, then the rest, and leaves when nothing is left", async () => {
    const { call, names, settled } = await legacyClient("cursor-vscode");

    const teams = await call(ENABLE_TOOLS, { groups: ["teams"] });
    expect(teams.isError).toBe(false);
    expect(teams.body.added).toEqual({ teams: inGroups("teams") });
    expect(teams.body.loaded).toEqual(["core", "teams"]);
    expect(await names()).toEqual(sorted([...inGroups("core", "teams"), ENABLE_TOOLS]));
    expect(await settled()).toBe(1);

    const again = await call(ENABLE_TOOLS, { groups: ["teams"] });
    expect(again.body).toMatchObject({ added: {}, alreadyLoaded: ["teams"] });
    expect(await settled()).toBe(1);

    const everything = await call(ENABLE_TOOLS, { groups: ["all"] });
    expect(Object.keys(everything.body.added).sort()).toEqual(
      TOOL_GROUP_NAMES.filter((g) => g !== "core" && g !== "teams").sort()
    );
    expect(await names()).toEqual(sorted(ALL));
    expect(await settled()).toBe(2);

    // Nothing left to load: enable_tools is gone from the list.
    await expect(call(ENABLE_TOOLS, { groups: ["teams"] })).rejects.toThrow(/not found/);
  });

  it("refuses group names it does not have", async () => {
    const { client } = await legacyClient("cursor-vscode");
    const result = (await client.callTool({
      name: ENABLE_TOOLS,
      arguments: { groups: ["core"] },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("serves a 2025-era client: lists and calls tools", async () => {
    const { client, call } = await legacyClient("some-2025-client");
    expect(client.getServerVersion()).toMatchObject({ name: "webhooks-cc" });
    expect(client.getInstructions()).toContain("enable_tools");
    const providers = await call("list_provider_templates");
    expect(providers.isError).toBe(false);
    expect(JSON.stringify(providers.body)).toContain("stripe");
  });

  it("reads a 2026-07-28 client's name from _meta before answering its first request", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    open.push(serveStdio(() => createServer(SERVER), { transport: serverSide }));
    const answers: JSONRPCMessage[] = [];
    clientSide.onmessage = (message) => {
      answers.push(message);
    };
    await clientSide.start();
    open.push(clientSide);
    const meta = (name: string) => ({
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      [CLIENT_INFO_META_KEY]: { name, version: "1.0.0" },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    });
    await clientSide.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: meta("claude-code") },
    });
    await vi.waitFor(() =>
      expect(answers.some((message) => "id" in message && message.id === 1)).toBe(true)
    );
    const answer = answers.find((message) => "id" in message && message.id === 1) as {
      result?: { tools: Array<{ name: string }> };
      error?: unknown;
    };
    expect(answer.error).toBeUndefined();
    expect(answer.result!.tools.map((tool) => tool.name).sort()).toEqual(sorted(ALL));
  });
});
