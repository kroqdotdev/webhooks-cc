import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgentAuthError, WebhooksCC, type SandboxClient } from "@webhooks-cc/sdk";
import { createServer } from "../index";

const BASE_URL = "https://webhooks.test";
const SANDBOX_TOOLS = [
  "about_sandbox",
  "connect_account",
  "create_endpoint",
  "delete_endpoint",
  "get_endpoint",
  "get_request",
  "list_endpoints",
  "list_requests",
  "wait_for_connection",
  "wait_for_request",
];

const attempt = {
  userCode: "123456",
  verificationUri: `${BASE_URL}/agent/claim?attempt=cat_x`,
  expiresAt: new Date(Date.now() + 15 * 60_000),
  interval: 5,
};

function fakeSandbox() {
  const endpoint = {
    id: "ep1",
    slug: "sbx1",
    url: "https://go.webhooks.test/w/sbx1",
    requestCount: 0,
    sandbox: { expiresAt: Date.now() + 86_400_000 },
  };
  const request = {
    id: "req1",
    endpointId: "ep1",
    method: "POST",
    path: "/",
    headers: {},
    body: "{}",
    queryParams: {},
    ip: "127.0.0.1",
    size: 2,
    receivedAt: Date.now(),
  };
  return {
    registration: { claimToken: "clm_sandbox" },
    expiresAt: new Date(Date.now() + 86_400_000),
    endpoints: {
      create: vi.fn().mockResolvedValue(endpoint),
      list: vi.fn().mockResolvedValue([endpoint]),
      get: vi.fn().mockResolvedValue(endpoint),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    requests: {
      list: vi.fn().mockResolvedValue([request]),
      get: vi.fn().mockResolvedValue(request),
      waitFor: vi.fn().mockResolvedValue(request),
    },
    claim: vi.fn().mockResolvedValue(attempt),
  };
}

async function connect() {
  const server = createServer({ baseUrl: BASE_URL });
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const changes: number[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes.push(Date.now());
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
  };
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name).sort();
  return { server, client, call, names, changes };
}

describe("sandbox tools (no API key)", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.WHK_API_KEY;
    delete process.env.WHK_API_KEY;
  });

  afterEach(() => {
    if (savedKey) process.env.WHK_API_KEY = savedKey;
    vi.restoreAllMocks();
  });

  it("lists the sandbox tools, with the full tools' names and arguments", async () => {
    const { client, names } = await connect();
    expect(await names()).toEqual(SANDBOX_TOOLS);
    const tools = (await client.listTools()).tools;
    const create = tools.find((tool) => tool.name === "create_endpoint")!;
    expect(Object.keys(create.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["name", "mockResponse", "notificationUrl"])
    );
    expect(create.description).toContain("up to 3 endpoints");
  });

  it("registers the sandbox on the first create_endpoint, once", async () => {
    const sandbox = fakeSandbox();
    const spy = vi
      .spyOn(WebhooksCC, "sandbox")
      .mockResolvedValue(sandbox as unknown as SandboxClient);
    const { call } = await connect();

    // Reads before any sandbox do not register one.
    expect((await call("list_endpoints")).body).toEqual([]);
    const read = await call("list_requests", { endpointSlug: "sbx1" });
    expect(read.isError).toBe(true);
    expect(read.body.message).toContain("No sandbox yet");
    expect(spy).not.toHaveBeenCalled();

    expect((await call("create_endpoint")).body.slug).toBe("sbx1");
    const named = await call("create_endpoint", { name: "x" });
    expect(named.body.note).toContain("no name");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: BASE_URL }));
    expect(sandbox.endpoints.create).toHaveBeenCalledTimes(2);

    expect((await call("list_requests", { endpointSlug: "sbx1" })).body[0].id).toBe("req1");
    expect((await call("get_request", { requestId: "req1" })).body.id).toBe("req1");
    expect((await call("wait_for_request", { endpointSlug: "sbx1" })).body.id).toBe("req1");
    expect((await call("list_requests", { endpointSlug: "sbx1", kind: "email" })).body).toEqual([]);
    expect((await call("delete_endpoint", { slug: "sbx1" })).body).toEqual({ deleted: "sbx1" });
  });

  it("refuses what needs an account", async () => {
    vi.spyOn(WebhooksCC, "sandbox").mockResolvedValue(fakeSandbox() as unknown as SandboxClient);
    const { call } = await connect();
    const mock = await call("create_endpoint", { mockResponse: { status: 201, body: "" } });
    expect(mock.isError).toBe(true);
    expect(mock.body.message).toContain("mockResponse need an account");
    const team = await call("list_endpoints", { team: "acme" });
    expect(team.isError).toBe(true);
    expect(team.body.message).toContain("Teams need an account");
  });

  it("connect_account claims the sandbox, or registers for the human without one", async () => {
    const sandbox = fakeSandbox();
    vi.spyOn(WebhooksCC, "sandbox").mockResolvedValue(sandbox as unknown as SandboxClient);
    const register = vi.spyOn(WebhooksCC.agent, "registerServiceAuth").mockResolvedValue({
      registrationId: "reg_sa",
      claimToken: "clm_sa",
      claimTokenExpires: new Date(Date.now() + 86_400_000),
      postClaimScopes: [],
      claim: attempt,
    });
    const restart = vi
      .spyOn(WebhooksCC.agent, "startClaim")
      .mockResolvedValue({ ...attempt, userCode: "654321", registrationId: "reg_sa" });

    // Without a sandbox: a service_auth registration, then a new code for it.
    const first = await connect();
    const started = await first.call("connect_account", { email: "Dev@Example.com" });
    expect(started.body).toMatchObject({
      userCode: "123456",
      verificationUri: attempt.verificationUri,
    });
    expect(started.body.tellTheHuman).toContain("sign in or sign up as dev@example.com");
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: BASE_URL, email: "dev@example.com" })
    );
    const again = await first.call("connect_account", { email: "dev@example.com" });
    expect(again.body.userCode).toBe("654321");
    expect(restart).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "clm_sa" }));
    expect(register).toHaveBeenCalledTimes(1);

    // With a sandbox: its own registration is claimed.
    const second = await connect();
    await second.call("create_endpoint");
    const claimed = await second.call("connect_account", { email: "dev@example.com" });
    expect(sandbox.claim).toHaveBeenCalledWith({ email: "dev@example.com" });
    expect(claimed.body.endpoints).toContain("move into that account");
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("wait_for_connection reports waiting, expiry and refusal", async () => {
    vi.spyOn(WebhooksCC.agent, "registerServiceAuth").mockResolvedValue({
      registrationId: "reg_sa",
      claimToken: "clm_sa",
      claimTokenExpires: new Date(Date.now() + 86_400_000),
      postClaimScopes: [],
      claim: attempt,
    });
    const wait = vi.spyOn(WebhooksCC.agent, "waitForClaim");
    const { call, names } = await connect();

    const early = await call("wait_for_connection");
    expect(early.isError).toBe(true);
    expect(early.body.message).toContain("call connect_account first");

    await call("connect_account", { email: "dev@example.com" });
    for (const [code, status] of [
      ["timeout", "waiting"],
      ["expired_token", "expired"],
      ["access_denied", "declined"],
    ] as const) {
      wait.mockRejectedValueOnce(new AgentAuthError(code, 400));
      const result = await call("wait_for_connection", { timeoutSeconds: 1 });
      expect(result.body).toMatchObject({ connected: false, status });
    }
    expect(wait).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "clm_sa", interval: 5, timeout: 1000 })
    );
    expect(await names()).toEqual(SANDBOX_TOOLS);
  });

  it("swaps in the full tools for the account once the human connects", async () => {
    const sandbox = fakeSandbox();
    vi.spyOn(WebhooksCC, "sandbox").mockResolvedValue(sandbox as unknown as SandboxClient);
    vi.spyOn(WebhooksCC.agent, "waitForClaim").mockResolvedValue({
      status: "claimed",
      token: {
        accessToken: "whcc_claimed",
        scope: "webhooks:read webhooks:write",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      identityAssertion: "ey.claimed.assertion",
      assertionExpires: new Date(Date.now() + 90 * 86_400_000),
    });
    const { call, names, changes } = await connect();
    await call("create_endpoint");
    await call("connect_account", { email: "dev@example.com" });

    const connected = await call("wait_for_connection");
    expect(connected.body).toMatchObject({ connected: true, email: "dev@example.com" });
    expect(connected.body.message).toContain("now that account's endpoints");

    const after = await names();
    expect(after).toHaveLength(38);
    expect(after).toEqual(expect.arrayContaining(["send_webhook", "describe", "list_teams"]));
    expect(after).not.toContain("connect_account");
    expect(after).not.toContain("about_sandbox");
    // Debounced: removing ten tools and adding 38 is one notification.
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
    expect(changes).toHaveLength(1);

    // The full tools act for the account with the claimed token.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json([{ id: "ep1", slug: "sbx1", isEphemeral: false }]));
    const listed = await call("list_endpoints");
    expect(listed.isError).toBe(false);
    const [, init] = fetchSpy.mock.calls[0];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer whcc_claimed");
  });
});
