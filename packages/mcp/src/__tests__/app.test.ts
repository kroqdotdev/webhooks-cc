import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildInspectorHtml, inspectorExports } from "../../scripts/build-app.mjs";
import { isSecretHeader, slugFromAddress, viewOf } from "../../app/model";
import { APP_MIME_TYPE, INSPECTOR_URI, appToolMeta } from "../app";
import { INSPECTOR_HASH, INSPECTOR_HTML } from "../app-html";
import { TOOL_CATALOG } from "../catalog";
import { createServer, type CreateServerOptions } from "../index";

// The request inspector (an MCP App): the page is built from app/, served
// as a resource, and named by get_request and get_email.

const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
});

/** A stand-in for the webhooks.cc API: one request, and no endpoints. */
async function fakeApi(request: Record<string, unknown>): Promise<string> {
  const server: Server = createHttpServer((req, res) => {
    const answer = req.url?.startsWith("/api/requests/")
      ? request
      : req.url?.startsWith("/api/endpoints")
        ? []
        : undefined;
    if (req.method === "GET" && answer !== undefined) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function connect(options: CreateServerOptions) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  open.push(serveStdio(() => createServer(options), { transport: serverSide }));
  // Named like Claude Code, which loads every group: get_email is listed too.
  const client = new Client({ name: "claude-code", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientSide as never);
  open.push(client);
  return client;
}

const INSPECTED = ["get_email", "get_request", "wait_for_email", "wait_for_request"];

describe("the request inspector", () => {
  it("is the page app/ builds (run scripts/build-app.mjs after changing it)", async () => {
    const built = inspectorExports(await buildInspectorHtml());
    expect(INSPECTOR_HTML).toBe(built.html);
    expect(INSPECTOR_HASH).toBe(built.hash);
    expect(INSPECTOR_URI).toBe(`ui://webhooks-cc/inspector-${built.hash}.html`);
  });

  it("is one small page that loads nothing from the network", () => {
    expect(Buffer.byteLength(INSPECTOR_HTML)).toBeLessThan(60_000);
    expect(INSPECTOR_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(INSPECTOR_HTML).not.toMatch(
      /<script[^>]+src=|<link[^>]+href=|@import|https?:\/\/[a-z]/i
    );
    // Captured values go in as text, never as markup.
    expect(INSPECTOR_HTML).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("names the inspector on the tools that answer one request or email", () => {
    const named = Object.keys(TOOL_CATALOG).filter((name) => appToolMeta(name) !== undefined);
    expect(named.sort()).toEqual(INSPECTED);
    expect(appToolMeta("get_request")).toEqual({
      ui: { resourceUri: INSPECTOR_URI },
      "ui/resourceUri": INSPECTOR_URI,
    });
  });

  it("is served by the local server, and its tools name it; the answer stays text", async () => {
    const request = {
      id: "req_1",
      endpointId: "ep_1",
      method: "POST",
      path: "/stripe",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: '{"type":"checkout.session.completed"}',
      queryParams: { a: "1" },
      ip: "203.0.113.9",
      size: 37,
      receivedAt: 1_763_000_000_000,
      responseStatus: 200,
      responseRule: null,
      kind: "http",
    };
    const client = await connect({ apiKey: "whcc_test", baseUrl: await fakeApi(request) });

    const { resources } = await client.listResources();
    const listed = resources.find((resource) => resource.uri === INSPECTOR_URI);
    expect(listed).toMatchObject({
      mimeType: APP_MIME_TYPE,
      _meta: { ui: { prefersBorder: true } },
    });
    const read = await client.readResource({ uri: INSPECTOR_URI });
    expect(read.contents).toEqual([
      {
        uri: INSPECTOR_URI,
        mimeType: "text/html;profile=mcp-app",
        text: INSPECTOR_HTML,
        _meta: {
          ui: {
            prefersBorder: true,
            permissions: { clipboardWrite: {} },
            csp: { connectDomains: [] },
          },
        },
      },
    ]);

    // A client holding a tool list from before a release asks for an older name.
    const old = "ui://webhooks-cc/inspector-0123456789abcdef.html";
    expect(old).not.toBe(INSPECTOR_URI);
    const stale = await client.readResource({ uri: old });
    expect(stale.contents).toEqual([{ ...read.contents[0], uri: old }]);
    expect(resources.filter((resource) => resource.uri.includes("inspector"))).toHaveLength(1);

    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (INSPECTED.includes(tool.name)) {
        expect(tool._meta, tool.name).toEqual({
          ui: { resourceUri: INSPECTOR_URI },
          "ui/resourceUri": INSPECTOR_URI,
        });
      } else {
        expect(tool._meta?.ui, tool.name).toBeUndefined();
      }
    }
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["get_request", "get_email"])
    );

    const result = (await client.callTool({
      name: "get_request",
      arguments: { requestId: "req_1" },
    })) as { content: Array<{ text: string }>; structuredContent?: unknown; isError?: boolean };
    expect(result.isError).toBeFalsy();
    // The inspector reads the text: a second copy would only cost the model tokens.
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: "req_1", method: "POST" });
  });

  it("is named by the sandbox's get_request too", async () => {
    const client = await connect({ credentialsFile: false, baseUrl: "http://127.0.0.1:9" });
    const { tools } = await client.listTools();
    const getRequest = tools.find((tool) => tool.name === "get_request");
    expect(getRequest?._meta).toEqual({
      ui: { resourceUri: INSPECTOR_URI },
      "ui/resourceUri": INSPECTOR_URI,
    });
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain(INSPECTOR_URI);
  });
});

describe("the inspector's model", () => {
  it("masks the headers the share links redact", () => {
    for (const name of [
      "Authorization",
      "cookie",
      "x-goog-api-key",
      "ocp-apim-subscription-key",
      "x-functions-key",
      "x-session-id",
      "x-amz-security-token",
      "stripe-signature",
      "x-hub-signature-256",
      "x-csrf-token",
      "client-secret",
      "x-jwt-assertion",
    ]) {
      expect(isSecretHeader(name), name).toBe(true);
    }
    for (const name of ["content-type", "user-agent", "x-github-event", "accept", "host"]) {
      expect(isSecretHeader(name), name).toBe(false);
    }
  });

  it("reads an endpoint's slug from a capture address only", () => {
    expect(slugFromAddress("Acme+run-1@mailhooks.cc")).toBe("acme");
    expect(slugFromAddress("orders@acme.example")).toBeNull();
    expect(slugFromAddress("nobody")).toBeNull();
  });

  it("leaves the slug of an email at a custom domain to its endpoint id", () => {
    const view = viewOf({
      id: "req_1",
      endpointId: "ep_1",
      kind: "email",
      method: "EMAIL",
      path: "orders@acme.example",
      receivedAt: 1_763_000_000_000,
      email: { subject: "Order 1001", from: [{ name: null, address: "shop@example.com" }] },
    });
    expect(view).toMatchObject({
      kind: "email",
      slug: null,
      endpointId: "ep_1",
      address: "orders@acme.example",
      subject: "Order 1001",
      full: false,
    });
    const captured = viewOf({
      id: "req_2",
      endpointId: "ep_2",
      kind: "email",
      method: "EMAIL",
      path: "acme+run-1@mailhooks.cc",
      email: {},
    });
    expect(captured).toMatchObject({ slug: "acme", endpointId: "ep_2" });
  });

  it("takes get_email's endpoint over the address", () => {
    const view = viewOf({
      id: "req_1",
      endpoint: { slug: "acme-orders", name: null },
      address: "orders@acme.example",
      subject: "Order 1001",
    });
    expect(view).toMatchObject({ kind: "email", slug: "acme-orders", full: true });
  });

  it("reads the subject of an email summary, which keeps it beside the message", () => {
    const view = viewOf({
      id: "req_1",
      kind: "email",
      method: "EMAIL",
      path: "acme@mailhooks.cc",
      subject: "Your code",
      shortened: true,
    });
    expect(view).toMatchObject({ kind: "email", subject: "Your code" });
  });
});
