import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { APP_MIME_TYPE, INSPECTOR_URI } from "@webhooks-cc/mcp/tools";

// The hosted server's registration of the request inspector (an MCP App):
// the resource on every per-request server, and the tools' _meta through
// the hosted adapter.

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({}),
  publicEnv: () => ({ NEXT_PUBLIC_WEBHOOK_URL: "https://go.webhooks.cc" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/forwarding/config", () => ({ sendOptions: () => ({}) }));
vi.mock("@/lib/forwarding/send", () => ({ sendForward: vi.fn() }));

const { buildServer } = await import("./hosted");

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
});

/** Sends one 2026-07-28 request to a fresh hosted server and returns its result. */
async function ask(method: string, params: Record<string, unknown> = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  open.push(
    serveStdio(
      () =>
        buildServer({
          token: "whcc_test",
          clientIp: null,
          userId: "user-1",
          groups: new Set(["core"]),
          readOnly: false,
        }),
      { transport: serverSide }
    )
  );
  const answers: JSONRPCMessage[] = [];
  clientSide.onmessage = (message) => {
    answers.push(message);
  };
  await clientSide.start();
  open.push(clientSide);
  await clientSide.send({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
        [CLIENT_INFO_META_KEY]: { name: "test", version: "1.0.0" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  });
  await vi.waitFor(() =>
    expect(answers.some((message) => "id" in message && message.id === 1)).toBe(true)
  );
  const answer = answers.find((message) => "id" in message && message.id === 1) as {
    result?: Record<string, unknown>;
    error?: unknown;
  };
  expect(answer.error).toBeUndefined();
  return answer.result!;
}

describe("the request inspector on the hosted server", () => {
  it("names the inspector on get_request and get_email", async () => {
    const { tools } = (await ask("tools/list")) as {
      tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
    };
    const meta = Object.fromEntries(tools.map((tool) => [tool.name, tool._meta]));
    for (const name of ["get_request", "get_email"]) {
      expect(meta[name], name).toEqual({
        ui: { resourceUri: INSPECTOR_URI },
        "ui/resourceUri": INSPECTOR_URI,
      });
    }
    expect(meta.list_requests?.ui).toBeUndefined();
  });

  it("serves the inspector page", async () => {
    const { contents } = (await ask("resources/read", { uri: INSPECTOR_URI })) as {
      contents: Array<{ uri: string; mimeType: string; text: string; _meta?: unknown }>;
    };
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({
      uri: INSPECTOR_URI,
      mimeType: APP_MIME_TYPE,
      _meta: { ui: { prefersBorder: true } },
    });
    expect(contents[0].text.startsWith("<!doctype html>")).toBe(true);
  });

  it("answers an older inspector name with the current page", async () => {
    // A client that cached tools/list before a release names the old hash.
    const old = "ui://webhooks-cc/inspector-0123456789abcdef.html";
    expect(old).not.toBe(INSPECTOR_URI);
    const { contents } = (await ask("resources/read", { uri: old })) as {
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    };
    const current = (await ask("resources/read", { uri: INSPECTOR_URI })) as {
      contents: Array<{ text: string }>;
    };
    expect(contents).toHaveLength(1);
    expect(contents[0]).toMatchObject({ uri: old, mimeType: APP_MIME_TYPE });
    expect(contents[0].text).toBe(current.contents[0].text);
  });
});
