import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  AgentAuthError,
  AgentCredentialStore,
  SandboxClient,
  WebhooksCC,
  type PendingConnection,
} from "@webhooks-cc/sdk";
import { createServer } from "../index";

const BASE_URL = "https://webhooks.test";
const SANDBOX_TOOLS = [
  "about_sandbox",
  "connect_account",
  "create_endpoint",
  "delete_endpoint",
  "generate_payload_schema",
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
    claim: vi.fn().mockResolvedValue({ ...attempt, movesEndpoints: true }),
    waitForClaim: vi.fn(),
  };
}

function fakePending(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...attempt,
    registrationId: "reg_sa",
    wait: vi.fn(),
    restart: vi.fn(),
    ...overrides,
  };
}

function accountClient(token = "whcc_claimed"): WebhooksCC {
  return new WebhooksCC({ baseUrl: BASE_URL, getAccessToken: async () => token });
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
    const schema = await call("generate_payload_schema", { endpointSlug: "sbx1" });
    expect(schema.isError).toBe(false);
    expect(schema.body).toMatchObject({ format: "typescript", samples: 1 });
    expect(schema.body.code).toContain("export interface WebhookPayload {");
    expect((await call("delete_endpoint", { slug: "sbx1" })).body).toEqual({ deleted: "sbx1" });
  });

  it("parallel first calls share one sandbox", async () => {
    const sandbox = fakeSandbox();
    const spy = vi
      .spyOn(WebhooksCC, "sandbox")
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(sandbox as unknown as SandboxClient), 20)
          )
      );
    const { call } = await connect();
    const created = await Promise.all([
      call("create_endpoint"),
      call("create_endpoint"),
      call("create_endpoint"),
    ]);
    expect(created.every((result) => !result.isError)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sandbox.endpoints.create).toHaveBeenCalledTimes(3);
  });

  it("replaces an expired sandbox once, however many calls notice", async () => {
    const expired = { ...fakeSandbox(), expiresAt: new Date(Date.now() - 1000) };
    const fresh = fakeSandbox();
    const spy = vi
      .spyOn(WebhooksCC, "sandbox")
      .mockResolvedValueOnce(expired as unknown as SandboxClient)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(fresh as unknown as SandboxClient), 20))
      );
    const { call } = await connect();
    await call("create_endpoint");
    await Promise.all([call("create_endpoint"), call("create_endpoint")]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(fresh.endpoints.create).toHaveBeenCalledTimes(2);
  });

  it("parallel calls share a failed registration's error; the next call retries", async () => {
    const sandbox = fakeSandbox();
    const spy = vi
      .spyOn(WebhooksCC, "sandbox")
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new AgentAuthError("rate_limited", 429, "Wait.")), 20)
          )
      )
      .mockResolvedValueOnce(sandbox as unknown as SandboxClient);
    const { call } = await connect();
    const failed = await Promise.all([
      call("create_endpoint"),
      call("create_endpoint"),
      call("create_endpoint"),
    ]);
    expect(failed.every((result) => result.isError)).toBe(true);
    expect(failed[2].body.message).toContain("rate_limited");
    expect(spy).toHaveBeenCalledTimes(1);

    expect((await call("create_endpoint")).isError).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
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
    const restarted = fakePending({ userCode: "654321" });
    const pending = fakePending({ restart: vi.fn().mockResolvedValue(restarted) });
    const connectSpy = vi
      .spyOn(WebhooksCC, "connect")
      .mockResolvedValue(pending as unknown as PendingConnection);

    // Without a sandbox: a service_auth registration, then a new code for it.
    const first = await connect();
    const started = await first.call("connect_account", { email: "Dev@Example.com" });
    expect(started.body).toMatchObject({
      userCode: "123456",
      verificationUri: attempt.verificationUri,
    });
    expect(started.body.tellTheHuman).toContain("sign in or sign up as dev@example.com");
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: BASE_URL, email: "dev@example.com" })
    );
    const again = await first.call("connect_account", { email: "dev@example.com" });
    expect(again.body.userCode).toBe("654321");
    expect(pending.restart).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);

    // With a sandbox: its own registration is claimed.
    const second = await connect();
    await second.call("create_endpoint");
    const claimed = await second.call("connect_account", { email: "dev@example.com" });
    expect(sandbox.claim).toHaveBeenCalledWith({ email: "dev@example.com" });
    expect(claimed.body.endpoints).toContain("move into that account");
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("a sandbox from an earlier session is reused, and connecting leaves it in place", async () => {
    const sandbox = fakeSandbox();
    sandbox.claim.mockResolvedValue({ ...attempt, movesEndpoints: false });
    const resume = vi
      .spyOn(SandboxClient, "resume")
      .mockResolvedValue(sandbox as unknown as SandboxClient);
    const register = vi.spyOn(WebhooksCC, "sandbox");
    const { call } = await connect();

    expect((await call("list_endpoints")).body[0].slug).toBe("sbx1");
    const claimed = await call("connect_account", { email: "dev@example.com" });
    expect(claimed.body.endpoints).toContain("stay in the sandbox");
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: BASE_URL }));
    expect(register).not.toHaveBeenCalled();
  });

  it("wait_for_connection reports waiting, expiry and refusal", async () => {
    const pending = fakePending();
    vi.spyOn(WebhooksCC, "connect").mockResolvedValue(pending as unknown as PendingConnection);
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
      pending.wait.mockRejectedValueOnce(new AgentAuthError(code, 400));
      const result = await call("wait_for_connection", { timeoutSeconds: 1 });
      expect(result.body).toMatchObject({ connected: false, status });
    }
    expect(pending.wait).toHaveBeenCalledWith({ timeout: 1000 });
    expect(await names()).toEqual(SANDBOX_TOOLS);
  });

  it("swaps in the full tools for the account once the human connects", async () => {
    const sandbox = fakeSandbox();
    sandbox.waitForClaim.mockResolvedValue(accountClient());
    vi.spyOn(WebhooksCC, "sandbox").mockResolvedValue(sandbox as unknown as SandboxClient);
    const { call, names, changes } = await connect();
    await call("create_endpoint");
    await call("connect_account", { email: "dev@example.com" });

    const connected = await call("wait_for_connection");
    expect(connected.body).toMatchObject({ connected: true, email: "dev@example.com" });
    expect(connected.body.message).toContain("now that account's endpoints");

    const after = await names();
    expect(after).toHaveLength(47);
    expect(after).toEqual(expect.arrayContaining(["send_webhook", "describe", "list_teams"]));
    expect(after).not.toContain("connect_account");
    expect(after).not.toContain("about_sandbox");
    // Debounced: removing eleven tools and adding 40 is one notification.
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

  it("starts with the full tools for a saved connection, and falls back when it is revoked", async () => {
    const file = process.env.WHK_AGENT_FILE!;
    const store = new AgentCredentialStore(file);
    store.save(BASE_URL, "claimed", {
      registration_id: "reg_claimed",
      identity_assertion: "ey.claimed.assertion",
      assertion_expires: new Date(Date.now() + 86_400_000).toISOString(),
      access_token: "whcc_saved",
      access_token_expires: new Date(Date.now() + 3_600_000).toISOString(),
    });
    try {
      const { call, names } = await connect();
      expect(await names()).toHaveLength(47);

      // The human disconnects the agent: the token dies and the assertion is refused.
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/oauth2/token") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({ error: "Invalid token" }, { status: 401 });
      });
      const refused = await call("list_endpoints");
      expect(refused.isError).toBe(true);
      await vi.waitFor(async () => expect(await names()).toEqual(SANDBOX_TOOLS));
      expect(store.load(BASE_URL).claimed).toBeNull();
    } finally {
      store.remove(BASE_URL, "claimed");
    }
  });
});
