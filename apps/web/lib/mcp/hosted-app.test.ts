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
import { MCP_VERSION } from "@/lib/changelog";

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

const { buildServer, TARGET_URL_NOTE } = await import("./hosted");

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
  vi.unstubAllGlobals();
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

describe("the hosted server", () => {
  it("reports the MCP package's version", async () => {
    // 2026-07-28 carries the server's identity in _meta.
    const result = (await ask("server/discover")) as {
      instructions?: string;
      _meta?: Record<string, { version?: string }>;
    };
    expect(result._meta?.["io.modelcontextprotocol/serverInfo"]?.version).toBe(MCP_VERSION);
    expect(result.instructions).toContain("?tools=");
  });

  it("never offers targetUrl, which would post from webhooks.cc's network", async () => {
    const { tools } = (await ask("tools/list")) as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: { properties?: Record<string, unknown> };
      }>;
    };
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const name of ["render_email", "test_webhook_flow"]) {
      expect(byName[name], name).toBeDefined();
      expect(Object.keys(byName[name].inputSchema.properties ?? {}), name).not.toContain(
        "targetUrl"
      );
      expect(byName[name].description, name).not.toContain("targetUrl");
    }
  });

  it("drops a targetUrl sent anyway, so nothing is posted there", async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const target =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        fetched.push(target);
        return Response.json({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      })
    );
    const result = (await ask("tools/call", {
      name: "render_email",
      arguments: {
        requestId: "req_1",
        format: "postmark",
        targetUrl: "http://localhost:3000/inbound",
      },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((target) => target.includes("/api/requests/req_1/render"))).toBe(true);
    expect(fetched.some((target) => target.startsWith("http://localhost:3000/inbound"))).toBe(
      false
    );
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    // A client whose tools/list still offered targetUrl hears that nothing was posted.
    expect(result.content.map((item) => item.text)).toContain(TARGET_URL_NOTE);
    expect(TARGET_URL_NOTE).toContain("npx -y @webhooks-cc/mcp");
  });

  it("adds no note to a call without targetUrl", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      )
    );
    const result = (await ask("tools/call", {
      name: "render_email",
      arguments: { requestId: "req_1", format: "postmark" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    expect(result.content.map((item) => item.text)).not.toContain(TARGET_URL_NOTE);
  });
});
