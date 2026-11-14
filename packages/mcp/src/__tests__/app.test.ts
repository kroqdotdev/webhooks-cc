import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildInspectorHtml, inspectorExports } from "../../scripts/build-app.mjs";
import {
  DASHBOARD_URL_META as MODEL_DASHBOARD_URL_META,
  MASK,
  dashboardUrlOf,
  isSecretHeader,
  maskQuery,
  slugForEndpoint,
  slugFromAddress,
  viewOf,
} from "../../app/model";
import {
  APP_MIME_TYPE,
  DASHBOARD_URL_META,
  INSPECTOR_URI,
  appToolMeta,
  dashboardRequestUrl,
  localDashboardOrigins,
} from "../app";
import { INSPECTOR_HASH, INSPECTOR_HTML } from "../app-html";
import { TOOL_CATALOG } from "../catalog";
import { createServer, type CreateServerOptions } from "../index";

// The request inspector (an MCP App): the page is built from app/, served
// as a resource, and named by get_request and get_email.

const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
});

/** A stand-in for the webhooks.cc API: one request, and one endpoint when given (else none). */
async function fakeApi(
  request: Record<string, unknown>,
  endpoint?: Record<string, unknown>
): Promise<string> {
  const server: Server = createHttpServer((req, res) => {
    const answer = req.url?.startsWith("/api/requests/")
      ? request
      : endpoint && req.url === `/api/endpoints/${String(endpoint.slug)}`
        ? endpoint
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

  it("gives an email's result its dashboard page in _meta, out of the model's text", async () => {
    const email = {
      id: "req_9",
      endpointId: "ep_1",
      endpointSlug: "acme",
      kind: "email",
      method: "EMAIL",
      path: "acme@mailhooks.cc",
      headers: {},
      body: "raw message",
      size: 2_000,
      receivedAt: 1_763_000_000_000,
      email: {
        subject: "Your receipt",
        from: [{ name: null, address: "shop@example.com" }],
        to: [],
        cc: [],
        replyTo: [],
        sender: [],
        date: null,
        messageId: null,
        inReplyTo: [],
        tag: null,
        text: "Thanks for your order.",
        html: "<p>Thanks for your <b>order</b>.</p>",
        textFromHtml: true,
        attachments: [],
        auth: null,
        smtp: null,
        parseError: false,
        truncated: { raw: false, text: false, html: false },
      },
    };
    const base = await fakeApi(email, {
      id: "ep_1",
      slug: "acme",
      name: "Acme",
      site: "mailhooks",
      showEmailExtracts: true,
    });
    const client = await connect({ apiKey: "whcc_test", baseUrl: base });
    // A dev server is one site: the link stays on it whatever the endpoint's site.
    const page = `${base}/dashboard?endpoint=acme&request=req_9`;

    for (const name of ["get_request", "get_email"]) {
      const result = (await client.callTool({ name, arguments: { requestId: "req_9" } })) as {
        content: Array<{ text: string }>;
        _meta?: Record<string, unknown>;
        isError?: boolean;
      };
      expect(result.isError, name).toBeFalsy();
      expect(result._meta?.[DASHBOARD_URL_META], name).toBe(page);
      expect(result.content[0].text, name).not.toContain("/dashboard");
      const data = JSON.parse(result.content[0].text);
      // The text the receiver made from the HTML part, said so; the HTML only by size.
      const message = name === "get_request" ? data.email : data;
      expect(message, name).toMatchObject({ textFromHtml: true, htmlSize: 36 });
      expect(message.html, name).toBeUndefined();
      expect(viewOf(data, result._meta), name).toMatchObject({
        kind: "email",
        text: "Thanks for your order.",
        textFromHtml: true,
        htmlSize: 36,
        dashboardUrl: page,
      });
    }
  });

  it("gives an HTTP request no dashboard link", async () => {
    const base = await fakeApi({
      id: "req_1",
      endpointId: "ep_1",
      endpointSlug: "acme",
      method: "POST",
      path: "/",
      headers: {},
      body: "{}",
      size: 2,
      receivedAt: 1_763_000_000_000,
      kind: "http",
    });
    const client = await connect({ apiKey: "whcc_test", baseUrl: base });
    const result = await client.callTool({
      name: "get_request",
      arguments: { requestId: "req_1" },
    });
    expect(result._meta?.[DASHBOARD_URL_META]).toBeUndefined();
  });

  it("links to the dashboard of the site that lists the endpoint", () => {
    expect(MODEL_DASHBOARD_URL_META).toBe(DASHBOARD_URL_META);
    const production = localDashboardOrigins(undefined);
    expect(production).toEqual({
      webhooks: "https://webhooks.cc",
      mailhooks: "https://mailhooks.cc",
    });
    expect(localDashboardOrigins("https://webhooks.cc/")).toEqual(production);
    expect(dashboardRequestUrl(production, "acme", "req_1", "mailhooks")).toBe(
      "https://mailhooks.cc/dashboard?endpoint=acme&request=req_1"
    );
    for (const site of ["webhooks", "both", null, undefined]) {
      expect(dashboardRequestUrl(production, "acme", "req_1", site)).toBe(
        "https://webhooks.cc/dashboard?endpoint=acme&request=req_1"
      );
    }
    // Another API (a dev server) is one site.
    const dev = localDashboardOrigins("http://localhost:3000");
    expect(dev).toEqual({ webhooks: "http://localhost:3000" });
    expect(dashboardRequestUrl(dev, "a b&c", "req/1", "mailhooks")).toBe(
      "http://localhost:3000/dashboard?endpoint=a+b%26c&request=req%2F1"
    );
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

  it("reads the endpoint's slug a request read by id names", () => {
    expect(
      viewOf({ id: "req_1", endpointId: "ep_1", endpointSlug: "acme", method: "POST", path: "/" })
    ).toMatchObject({ kind: "http", slug: "acme", endpointId: "ep_1" });
    expect(viewOf({ id: "req_1", endpointId: "ep_1", method: "POST", path: "/" })).toMatchObject({
      slug: null,
    });
    // An email at a custom domain: its address names no endpoint, the answer does.
    expect(
      viewOf({
        id: "req_2",
        endpointId: "ep_2",
        endpointSlug: "acme-orders",
        kind: "email",
        method: "EMAIL",
        path: "orders@acme.example",
        email: {},
      })
    ).toMatchObject({ kind: "email", slug: "acme-orders" });
  });

  it("masks the query values a share link hides", () => {
    expect(maskQuery("?code=abc123&state=xyz&page=2&sig=s&api_key=k&key=k2&access_token=t")).toBe(
      `?code=${MASK}&state=${MASK}&page=2&sig=${MASK}&api_key=${MASK}&key=${MASK}&access_token=${MASK}`
    );
    // Names are matched decoded and in any case; the rest stays as sent.
    expect(maskQuery("?Api%2DKey=k&q=a+b&flag&empty=")).toBe(
      `?Api%2DKey=${MASK}&q=a+b&flag&empty=`
    );
    expect(maskQuery("")).toBe("");
    const view = viewOf({
      id: "req_1",
      method: "GET",
      path: "/oauth/callback",
      queryRaw: "code=abc123&state=xyz",
    });
    expect(view).toMatchObject({ query: `?code=${MASK}&state=${MASK}` });
    expect(JSON.stringify(view)).not.toContain("abc123");
    const fromParams = viewOf({
      id: "req_2",
      method: "GET",
      path: "/",
      queryParams: { token: "t0ps3cret", page: "2" },
    });
    expect(fromParams).toMatchObject({ query: `?token=${MASK}&page=2` });
  });

  it("finds an endpoint's slug in list_endpoints, and knows a cut list may leave it out", () => {
    const listed = [{ id: "ep_1", slug: "acme" }];
    expect(slugForEndpoint(listed, "ep_1")).toEqual({ slug: "acme", listed: true });
    expect(slugForEndpoint(listed, "ep_2")).toEqual({ slug: null, listed: true });
    const cut = { items: listed, truncated: true, total: 400, returned: 1 };
    expect(slugForEndpoint(cut, "ep_1")).toEqual({ slug: "acme", listed: true });
    expect(slugForEndpoint(cut, "ep_2")).toEqual({ slug: null, listed: false });
  });

  it("shows an HTML-only email's text made from its HTML, and links to the dashboard", () => {
    const page = "https://webhooks.cc/dashboard?endpoint=acme&request=req_1";
    const meta = { [MODEL_DASHBOARD_URL_META]: page };
    // get_request's compact email: the receiver made the text from the HTML part.
    const compact = viewOf(
      {
        id: "req_1",
        endpointSlug: "acme",
        kind: "email",
        method: "EMAIL",
        path: "acme@mailhooks.cc",
        email: { text: "Your code is 123456", textFromHtml: true, htmlSize: 4_200 },
      },
      meta
    );
    expect(compact).toMatchObject({
      text: "Your code is 123456",
      textFromHtml: true,
      htmlSize: 4_200,
      dashboardUrl: page,
    });
    // get_email's answer says so the same way.
    const detail = viewOf(
      {
        id: "req_1",
        endpoint: { slug: "acme", name: null },
        address: "acme@mailhooks.cc",
        text: "Your code is 123456",
        textFromHtml: true,
        htmlSize: 4_200,
      },
      meta
    );
    expect(detail).toMatchObject({ textFromHtml: true, dashboardUrl: page, full: true });
    // HTML-only mail captured before the receiver made text from it: no text, still the link.
    expect(
      viewOf(
        { id: "req_1", kind: "email", path: "acme@mailhooks.cc", email: { htmlSize: 900 } },
        meta
      )
    ).toMatchObject({ text: null, textFromHtml: false, htmlSize: 900, dashboardUrl: page });
  });

  it("shows an email with both parts as its text part, with the dashboard link", () => {
    const page = "https://mailhooks.cc/dashboard?endpoint=acme&request=req_2";
    const view = viewOf(
      {
        id: "req_2",
        kind: "email",
        path: "acme@mailhooks.cc",
        email: { text: "Plain text part", textFromHtml: false, htmlSize: 12_000 },
      },
      { [MODEL_DASHBOARD_URL_META]: page }
    );
    expect(view).toMatchObject({
      text: "Plain text part",
      textFromHtml: false,
      htmlSize: 12_000,
      dashboardUrl: page,
    });
    // Without _meta (a host that drops it), there is no link.
    expect(
      viewOf({ id: "req_2", kind: "email", path: "acme@mailhooks.cc", email: {} })
    ).toMatchObject({ dashboardUrl: null });
  });

  it("takes only an http(s) dashboard link", () => {
    expect(dashboardUrlOf({ [MODEL_DASHBOARD_URL_META]: "javascript:alert(1)" })).toBeNull();
    expect(dashboardUrlOf({ [MODEL_DASHBOARD_URL_META]: "not a url" })).toBeNull();
    expect(dashboardUrlOf({ [MODEL_DASHBOARD_URL_META]: 42 })).toBeNull();
    expect(dashboardUrlOf(null)).toBeNull();
    expect(dashboardUrlOf({ [MODEL_DASHBOARD_URL_META]: "https://webhooks.cc/dashboard" })).toBe(
      "https://webhooks.cc/dashboard"
    );
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
