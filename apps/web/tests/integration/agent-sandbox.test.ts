/**
 * @fileoverview The agent sandbox (auth.md v0.6): what an anonymous
 * registration's access token can do. Endpoints belong to the registration,
 * so isolation is checked between two registrations and against a real
 * account; captures go through capture_webhook() (the 25-per-endpoint cap,
 * the registration budget, the agent:<id> billing key) and once through the
 * receiver.
 *
 * Needs the local Supabase stack with migration 00055, the signing key and
 * PoW secret in .env.local, and the receiver (`make dev-receiver`). Run with:
 *   cd apps/web && npx vitest run --config vitest.config.ts tests/integration/agent-sandbox.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  adminClient,
  bearer,
  cleanupRegistrations,
  configureAgentEnv,
  registerAnonymous,
  sandboxAgent,
  slugParams,
  type AgentRoutes,
  loadAgentRoutes,
} from "./agent-helpers";

configureAgentEnv();

const admin = adminClient();
const RUN = Date.now();
const USER_EMAIL = `agent-sandbox-user-${RUN}@webhooks-test.local`;
const PASSWORD = "TestPassword123!";
const RECEIVER = process.env.NEXT_PUBLIC_WEBHOOK_URL ?? "http://localhost:3001";
const SANDBOX = "/api/agent/sandbox/endpoints";

const created = new Set<string>();
let routes: AgentRoutes;
let userId: string;
let userApiKey: string;
let userSession: string;
let guestGet: (r: Request, c: { params: Promise<{ slug: string }> }) => Promise<Response>;
let guestRequests: (r: Request, c: { params: Promise<{ slug: string }> }) => Promise<Response>;
let claimPost: (r: Request) => Promise<Response>;

type Agent = { registrationId: string; token: string };

async function createEndpoint(agent: Agent) {
  const res = await routes.sandboxCreate(bearer("POST", SANDBOX, agent.token, {}));
  return { status: res.status, body: await res.json() };
}

async function capture(slug: string, path = "/hook") {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "POST",
    p_path: path,
    p_headers: { "content-type": "application/json" },
    p_body: JSON.stringify({ path }),
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "203.0.113.9",
    p_received_at: new Date().toISOString(),
  });
  if (error) throw error;
  return data as { status: string; billing_key?: string; request_id?: string };
}

async function registration(id: string) {
  const { data } = await admin.from("agent_registrations").select("*").eq("id", id).single();
  return data!;
}

describe("agent sandbox", () => {
  let alice: Agent;
  let bob: Agent;

  beforeAll(async () => {
    routes = await loadAgentRoutes();
    const [guest, guestReq, claim] = await Promise.all([
      import("@/app/api/go/endpoint/[slug]/route"),
      import("@/app/api/go/endpoint/[slug]/requests/route"),
      import("@/app/api/endpoints/claim/route"),
    ]);
    guestGet = guest.GET;
    guestRequests = guestReq.GET;
    claimPost = claim.POST;

    const { data: user, error } = await admin.auth.admin.createUser({
      email: USER_EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    userId = user.user!.id;
    const anon = createClient(
      process.env.SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
      }
    );
    const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
      email: USER_EMAIL,
      password: PASSWORD,
    });
    if (signInError) throw signInError;
    userSession = signIn.session!.access_token;
    const { generateApiKey, hashApiKey } = await import("@/lib/supabase/api-keys");
    userApiKey = generateApiKey();
    await admin.from("api_keys").insert({
      user_id: userId,
      key_hash: hashApiKey(userApiKey),
      key_prefix: userApiKey.slice(0, 12),
      name: "agent-sandbox test key",
    });

    alice = await sandboxAgent(routes, created, "alice");
    bob = await sandboxAgent(routes, created, "bob");
  });

  afterAll(async () => {
    await cleanupRegistrations(admin, created);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  });

  it("admits only a live anonymous registration's token", async () => {
    const none = await routes.sandboxList(new Request(`https://webhooks.cc${SANDBOX}`));
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("resource_metadata=");

    const garbage = await routes.sandboxList(bearer("GET", SANDBOX, "whcc_not_a_key"));
    expect(garbage.status).toBe(401);

    const apiKey = await routes.sandboxList(bearer("GET", SANDBOX, userApiKey));
    expect(apiKey.status).toBe(403);
    expect((await apiKey.json()).error).toBe("sandbox_only");

    const session = await routes.sandboxList(bearer("GET", SANDBOX, userSession));
    expect(session.status).toBe(403);
  });

  it("creates a capture-only endpoint owned by the registration", async () => {
    const { status, body } = await createEndpoint(alice);
    expect(status).toBe(201);
    const reg = await registration(alice.registrationId);
    expect(body).toMatchObject({
      isEphemeral: true,
      requestCount: 0,
      emailAddress: null,
      forwardEnabled: false,
      sandbox: {
        expiresAt: Date.parse(reg.expires_at),
        maxEndpoints: 3,
        requestLimit: 25,
        budget: { used: 0, limit: 100 },
      },
    });
    expect(body.url).toBe(`${RECEIVER}/w/${body.slug}`);
    expect(body.expiresAt).toBe(Date.parse(reg.expires_at));

    const { data: row } = await admin.from("endpoints").select("*").eq("id", body.id).single();
    expect(row).toMatchObject({
      user_id: null,
      agent_registration_id: alice.registrationId,
      is_ephemeral: true,
      name: null,
      mock_response: null,
      notification_url: null,
      signing_provider: null,
    });
    expect(Date.parse(row.expires_at)).toBe(Date.parse(reg.expires_at));

    const { data: audit } = await admin
      .from("audit_events")
      .select("metadata")
      .eq("action", "agent.sandbox.endpoint_created")
      .eq("target_id", alice.registrationId);
    expect(audit?.[0]?.metadata).toMatchObject({ endpoint_id: body.id });
  });

  it("ignores settings in the body", async () => {
    const res = await routes.sandboxCreate(
      bearer("POST", SANDBOX, bob.token, {
        name: "sandbox:spoofed",
        mockResponse: { status: 418, body: "teapot", headers: {} },
        notificationUrl: "https://example.com/hook",
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    const { data: row } = await admin
      .from("endpoints")
      .select("name, mock_response, notification_url")
      .eq("id", body.id)
      .single();
    expect(row).toEqual({ name: null, mock_response: null, notification_url: null });
  });

  it("holds three endpoints, and a delete frees a slot", async () => {
    const agent = await sandboxAgent(routes, created, "three");
    const slugs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { status, body } = await createEndpoint(agent);
      expect(status).toBe(201);
      slugs.push(body.slug);
    }
    const fourth = await createEndpoint(agent);
    expect(fourth.status).toBe(409);
    expect(fourth.body.error).toBe("sandbox_endpoint_limit");

    const list = await (await routes.sandboxList(bearer("GET", SANDBOX, agent.token))).json();
    expect(list.endpoints.map((e: { slug: string }) => e.slug).sort()).toEqual([...slugs].sort());

    const deleted = await routes.sandboxDelete(
      bearer("DELETE", `${SANDBOX}/${slugs[0]}`, agent.token),
      slugParams(slugs[0])
    );
    expect(deleted.status).toBe(204);
    expect((await createEndpoint(agent)).status).toBe(201);
  });

  it("keeps registrations apart and keeps sandbox endpoints out of guest paths", async () => {
    const { body: mine } = await createEndpoint(alice);
    const captured = await capture(mine.slug, "/alice-only");
    expect(captured.status).toBe("ok");

    // Bob sees nothing of Alice's.
    const asBob = (method: string, path: string) => bearer(method, path, bob.token);
    expect(
      (await routes.sandboxGet(asBob("GET", `${SANDBOX}/${mine.slug}`), slugParams(mine.slug)))
        .status
    ).toBe(404);
    expect(
      (
        await routes.sandboxRequests(
          asBob("GET", `${SANDBOX}/${mine.slug}/requests`),
          slugParams(mine.slug)
        )
      ).status
    ).toBe(404);
    expect(
      (
        await routes.sandboxDelete(
          asBob("DELETE", `${SANDBOX}/${mine.slug}`),
          slugParams(mine.slug)
        )
      ).status
    ).toBe(404);
    const foreignRequest = await routes.sandboxRequest(
      asBob("GET", `/api/agent/sandbox/requests/${captured.request_id}`),
      { params: Promise.resolve({ id: captured.request_id! }) }
    );
    expect(foreignRequest.status).toBe(404);
    const bobList = await (await routes.sandboxList(asBob("GET", SANDBOX))).json();
    expect(bobList.endpoints.map((e: { slug: string }) => e.slug)).not.toContain(mine.slug);

    // Alice reads her own.
    const own = await routes.sandboxRequest(
      bearer("GET", `/api/agent/sandbox/requests/${captured.request_id}`, alice.token),
      { params: Promise.resolve({ id: captured.request_id! }) }
    );
    expect(own.status).toBe(200);
    expect((await own.json()).path).toBe("/alice-only");
    const badId = await routes.sandboxRequest(
      bearer("GET", "/api/agent/sandbox/requests/not-a-uuid", alice.token),
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );
    expect(badId.status).toBe(404);

    // Guest reads and the guest claim do not see sandbox endpoints.
    const plain = new Request(`https://webhooks.cc/api/go/endpoint/${mine.slug}`);
    expect((await guestGet(plain, slugParams(mine.slug))).status).toBe(404);
    expect((await guestRequests(plain, slugParams(mine.slug))).status).toBe(404);
    const claim = await claimPost(
      new Request("https://webhooks.cc/api/endpoints/claim", {
        method: "POST",
        headers: { authorization: `Bearer ${userSession}`, "content-type": "application/json" },
        body: JSON.stringify({ slug: mine.slug }),
      })
    );
    expect(claim.status).toBe(404);
    const { data: still } = await admin
      .from("endpoints")
      .select("user_id, agent_registration_id")
      .eq("id", mine.id)
      .single();
    expect(still).toEqual({ user_id: null, agent_registration_id: alice.registrationId });
  });

  it("caps captures per endpoint and per registration, billed as agent:<id>", async () => {
    const agent = await sandboxAgent(routes, created, "budget");
    const first = (await createEndpoint(agent)).body;
    const second = (await createEndpoint(agent)).body;
    const billingKey = `agent:${agent.registrationId}`;

    const { data: key } = await admin.rpc("capture_billing_key", { p_slug: first.slug });
    expect(key).toBe(billingKey);

    for (let i = 0; i < 25; i += 1) {
      const result = await capture(first.slug, `/n/${i}`);
      expect(result).toMatchObject({ status: "ok", billing_key: billingKey });
    }
    // The endpoint is full. Its refusal still spent a unit of the budget.
    expect(await capture(first.slug)).toMatchObject({
      status: "quota_exceeded",
      billing_key: billingKey,
    });
    expect((await registration(agent.registrationId)).sandbox_requests_used).toBe(26);

    // Shrink the budget to see the registration-wide cap on the second endpoint.
    await admin
      .from("agent_registrations")
      .update({ sandbox_request_limit: 30 })
      .eq("id", agent.registrationId);
    for (let i = 0; i < 4; i += 1) {
      expect((await capture(second.slug)).status).toBe("ok");
    }
    expect((await capture(second.slug)).status).toBe("quota_exceeded");
    expect((await registration(agent.registrationId)).sandbox_requests_used).toBe(30);

    // A delete does not refund the budget.
    await routes.sandboxDelete(
      bearer("DELETE", `${SANDBOX}/${first.slug}`, agent.token),
      slugParams(first.slug)
    );
    const third = (await createEndpoint(agent)).body;
    expect((await capture(third.slug)).status).toBe("quota_exceeded");

    // Reads report the budget and the captures, newest first.
    const listed = await (await routes.sandboxList(bearer("GET", SANDBOX, agent.token))).json();
    expect(listed.sandbox.budget).toEqual({ used: 30, limit: 30 });
    const requests = await (
      await routes.sandboxRequests(
        bearer("GET", `${SANDBOX}/${second.slug}/requests?limit=2`, agent.token),
        slugParams(second.slug)
      )
    ).json();
    expect(requests).toHaveLength(2);
    expect(requests[0].receivedAt).toBeGreaterThanOrEqual(requests[1].receivedAt);
    const future = await (
      await routes.sandboxRequests(
        bearer(
          "GET",
          `${SANDBOX}/${second.slug}/requests?since=${Date.now() + 60_000}`,
          agent.token
        ),
        slugParams(second.slug)
      )
    ).json();
    expect(future).toEqual([]);
    const badLimit = await routes.sandboxRequests(
      bearer("GET", `${SANDBOX}/${second.slug}/requests?limit=0`, agent.token),
      slugParams(second.slug)
    );
    expect(badLimit.status).toBe(400);
    const farFuture = await routes.sandboxRequests(
      bearer("GET", `${SANDBOX}/${second.slug}/requests?since=1e300`, agent.token),
      slugParams(second.slug)
    );
    expect(farFuture.status).toBe(400);
  });

  it("captures through the receiver and answers 429 at the cap", async () => {
    const agent = await sandboxAgent(routes, created, "receiver");
    const { body: endpoint } = await createEndpoint(agent);
    const res = await fetch(`${RECEIVER}/w/${endpoint.slug}/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "sandbox" }),
    });
    expect(res.status).toBe(200);

    const requests = await (
      await routes.sandboxRequests(
        bearer("GET", `${SANDBOX}/${endpoint.slug}/requests`, agent.token),
        slugParams(endpoint.slug)
      )
    ).json();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/stripe",
      body: '{"hello":"sandbox"}',
    });

    await admin
      .from("agent_registrations")
      .update({ sandbox_request_limit: 1 })
      .eq("id", agent.registrationId);
    const refused = await fetch(`${RECEIVER}/w/${endpoint.slug}`, { method: "POST", body: "x" });
    expect(refused.status).toBe(429);
  });

  it("answers sandbox_full when the pool is full, and registration says so", async () => {
    const agent = await sandboxAgent(routes, created, "pool");
    const env = routes.serverEnv();
    const original = env.AGENT_SANDBOX_MAX_ENDPOINTS;
    const { count } = await admin
      .from("endpoints")
      .select("id", { count: "exact", head: true })
      .not("agent_registration_id", "is", null)
      .gt("expires_at", new Date().toISOString());
    env.AGENT_SANDBOX_MAX_ENDPOINTS = count ?? 0;
    routes.invalidatePoolUsage();
    try {
      const full = await routes.sandboxCreate(bearer("POST", SANDBOX, agent.token, {}));
      expect(full.status).toBe(503);
      expect(full.headers.get("retry-after")).toBe("600");
      expect((await full.json()).error).toBe("sandbox_full");
      const { data: audit } = await admin
        .from("audit_events")
        .select("outcome")
        .eq("action", "agent.sandbox.full")
        .eq("target_id", agent.registrationId);
      expect(audit).toHaveLength(1);

      const { body } = await registerAnonymous(routes, created, "late");
      expect((body.sandbox as { status: string }).status).toBe("full");
    } finally {
      env.AGENT_SANDBOX_MAX_ENDPOINTS = original;
      routes.invalidatePoolUsage();
    }
  });

  it("closes once the registration is claimed or revoked", async () => {
    const claimed = await sandboxAgent(routes, created, "claimed");
    await admin
      .from("agent_registrations")
      .update({ user_id: userId, claimed_at: new Date().toISOString() })
      .eq("id", claimed.registrationId);
    const closed = await routes.sandboxList(bearer("GET", SANDBOX, claimed.token));
    expect(closed.status).toBe(403);
    expect((await closed.json()).error).toBe("sandbox_closed");

    const revoked = await sandboxAgent(routes, created, "revoked");
    const { body: endpoint } = await createEndpoint(revoked);
    await admin
      .from("agent_registrations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", revoked.registrationId);
    expect((await createEndpoint(revoked)).status).toBe(403);
    // A revoked registration's endpoints capture nothing.
    expect((await capture(endpoint.slug)).status).toBe("quota_exceeded");
  });
});
