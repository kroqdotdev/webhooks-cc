/**
 * @fileoverview Integration suite for the UNCLAIMED-AGENT SANDBOX surface
 * (WorkOS auth.md "works immediately" promise). Exercises
 *   POST /api/agent/sandbox/endpoints  — create a bounded ephemeral endpoint
 *   GET  /api/agent/sandbox/endpoints  — list this key's sandbox endpoints
 *   GET  /api/agent/sandbox/endpoints?slug=... — read ONLY its own requests
 *
 * The single most important property under test is CROSS-TENANT ISOLATION: an
 * unclaimed agent key (user_id NULL) may only ever see endpoints/requests
 * created under its OWN api_keys row, never another agent's and never a real
 * user's. The route scopes by the server-only api_keys row id via an
 * endpoints.name marker ("sandbox:<keyId>"), since user_id is NULL for every
 * unclaimed key and cannot be used to isolate them.
 *
 * Requires a LIVE Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from
 * .env.local) and migration 00029 applied (agent auth tables). NOT run in CI —
 * run with:
 *   cd apps/web && npx vitest run tests/integration/agent-sandbox.test.ts
 *
 * Route handlers are invoked DIRECTLY (their GET/POST exports) with a real
 * `Request`, asserting on `res.status` + `await res.json()`. Unclaimed agent
 * credentials are minted via the real register route (POST /api/agent/auth) so
 * the api_keys rows match exactly what production issues.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}
if (!ANON_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY env var required for integration tests");
}

// Guard: the in-app claim ceremony + key minting must never run against a real
// mailbox or production env.
if (process.env.NODE_ENV === "production") {
  throw new Error("agent-sandbox integration test must not run with NODE_ENV=production");
}

// Generous per-IP registration limits so the many register/claim calls here
// never trip the rate limiter. Must be set BEFORE any route/lib reads
// serverEnv() (env is parsed + cached lazily on first access).
process.env.AGENT_REGISTER_RATE_LIMIT = "1000";
process.env.AGENT_IDJAG_RATE_LIMIT = "1000";
process.env.AGENT_REGISTER_RATE_WINDOW_MS = "3600000";

const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_PASSWORD = "TestPassword123!";
const RUN = Date.now();
const REAL_USER_EMAIL = `sandbox-real-user-${RUN}@webhooks-test.local`;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Unique X-Forwarded-For so per-IP rate limiting never crosses test cases. */
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
}

function bearerGet(url: string, token: string): Request {
  return new Request(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
}

const SANDBOX_URL = "https://webhooks.cc/api/agent/sandbox/endpoints";

// ---------------------------------------------------------------------------
// Dynamically imported route/lib handlers, populated in beforeAll AFTER the env
// is set so the first serverEnv() parse sees the test configuration.
// ---------------------------------------------------------------------------
type Handlers = {
  sandboxGet: (req: Request) => Promise<Response>;
  sandboxPost: (req: Request) => Promise<Response>;
  registerPost: (req: Request) => Promise<Response>;
  confirmPost: (req: Request) => Promise<Response>;
};

let h: Handlers;

// State captured across cases for cleanup.
const createdApiKeyHashes = new Set<string>();
const createdClaimTokenHashes = new Set<string>();
const createdEndpointIds = new Set<string>();
const createdUserIds = new Set<string>();

// A real logged-in user (for the claim ceremony + a normal owned API key).
let realUserId: string;
let realUserAccessToken: string;
let realUserApiKey: string;

/** Mint a fresh UNCLAIMED anonymous agent credential via the real register route. */
async function mintAnonymousKey(
  clientName: string
): Promise<{ credential: string; claimToken: string }> {
  const res = await h.registerPost(
    jsonRequest("https://webhooks.cc/api/agent/auth", {
      type: "anonymous",
      requested_credential_type: "api_key",
      client_name: clientName,
    })
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.credential).toMatch(/^whcc_/);
  expect(body.claim_token).toMatch(/^clm_/);
  createdApiKeyHashes.add(sha256Hex(body.credential));
  createdClaimTokenHashes.add(sha256Hex(body.claim_token));
  return { credential: body.credential, claimToken: body.claim_token };
}

/** Insert a captured request directly against a sandbox endpoint (unowned). */
async function insertRequest(endpointId: string, path: string): Promise<string> {
  const { data, error } = await admin
    .from("requests")
    .insert({
      endpoint_id: endpointId,
      // Sandbox endpoints are unowned (user_id NULL), and so are their requests.
      user_id: null,
      method: "POST",
      path,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
      query_params: {},
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 11,
      received_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

describe("Agent Sandbox (unclaimed-key) Integration", () => {
  beforeAll(async () => {
    const [registerMod, confirmMod, sandboxMod] = await Promise.all([
      import("@/app/api/agent/auth/route"),
      import("@/app/api/agent/auth/claim/confirm/route"),
      import("@/app/api/agent/sandbox/endpoints/route"),
    ]);

    h = {
      registerPost: registerMod.POST,
      confirmPost: confirmMod.POST,
      sandboxGet: sandboxMod.GET,
      sandboxPost: sandboxMod.POST,
    };

    // A real logged-in user: used for (a) the claim ceremony session token,
    // (b) a normal owned API key, and (c) an owned endpoint that the sandbox
    // must NEVER surface to any agent.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: REAL_USER_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Sandbox Real User" },
    });
    if (createErr) throw createErr;
    realUserId = created.user!.id;
    createdUserIds.add(realUserId);

    const anonClient = createClient(SUPABASE_URL, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: signIn, error: signInErr } = await anonClient.auth.signInWithPassword({
      email: REAL_USER_EMAIL,
      password: TEST_PASSWORD,
    });
    if (signInErr) throw signInErr;
    realUserAccessToken = signIn.session!.access_token;

    // A normal (non-agent) owned API key for this user.
    realUserApiKey = `whcc_${RUN}sandboxowner${Math.random().toString(36).slice(2)}`;
    const { error: keyErr } = await admin.from("api_keys").insert({
      user_id: realUserId,
      key_hash: sha256Hex(realUserApiKey),
      key_prefix: realUserApiKey.slice(0, 12),
      name: "owner-key",
    });
    if (keyErr) throw keyErr;
    createdApiKeyHashes.add(sha256Hex(realUserApiKey));
  });

  afterAll(async () => {
    if (createdEndpointIds.size > 0) {
      // Remove requests first (FK), then the sandbox endpoints themselves.
      await admin.from("requests").delete().in("endpoint_id", [...createdEndpointIds]);
      await admin.from("endpoints").delete().in("id", [...createdEndpointIds]);
    }
    if (createdApiKeyHashes.size > 0) {
      await admin.from("api_keys").delete().in("key_hash", [...createdApiKeyHashes]);
    }
    if (createdClaimTokenHashes.size > 0) {
      await admin.from("agent_claims").delete().in("claim_token_hash", [...createdClaimTokenHashes]);
    }
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // (1) AUTH BOUNDARY — only an UNCLAIMED agent key is admitted.
  // -------------------------------------------------------------------------
  it("rejects unauthenticated / non-agent / claimed bearers", async () => {
    // No Authorization -> 401 with the RFC 9728 challenge pointing at the
    // protected-resource metadata (reused from the bearer boundary).
    const noAuth = await h.sandboxGet(new Request(SANDBOX_URL, { method: "GET" }));
    expect(noAuth.status).toBe(401);

    // Unknown bearer -> 401 with the WWW-Authenticate challenge.
    const unknown = await h.sandboxGet(bearerGet(SANDBOX_URL, "whcc_does_not_exist"));
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("WWW-Authenticate")).toContain("resource_metadata=");

    // A normal OWNED (non-agent) API key -> 403: it must use /api/endpoints.
    const ownedKey = await h.sandboxGet(bearerGet(SANDBOX_URL, realUserApiKey));
    expect(ownedKey.status).toBe(403);

    // A logged-in user's session token -> 403 (the sandbox is agent-only).
    const session = await h.sandboxGet(bearerGet(SANDBOX_URL, realUserAccessToken));
    expect(session.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // (2) CREATE — an unclaimed key may create bounded ephemeral endpoints.
  // -------------------------------------------------------------------------
  it("creates an ephemeral sandbox endpoint for an unclaimed key", async () => {
    const { credential } = await mintAnonymousKey("sandbox-create-agent");

    const res = await h.sandboxPost(jsonRequest(SANDBOX_URL, {}, { authorization: `Bearer ${credential}` }));
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(typeof body.id).toBe("string");
    expect(typeof body.slug).toBe("string");
    expect(body.isEphemeral).toBe(true);
    expect(body.sandbox).toBe(true);
    expect(typeof body.expiresAt).toBe("number");
    expect(typeof body.ttl_hours).toBe("number");
    expect(typeof body.claim_hint).toBe("string");
    createdEndpointIds.add(body.id);

    // DB: the endpoint is ephemeral, UNOWNED, and bound to the key via the
    // server-side name marker "sandbox:<keyId>" — never to a user.
    const { data: keyRow } = await admin
      .from("api_keys")
      .select("id")
      .eq("key_hash", sha256Hex(credential))
      .single();
    const { data: epRow } = await admin
      .from("endpoints")
      .select("user_id, is_ephemeral, expires_at, name")
      .eq("id", body.id)
      .single();
    expect(epRow!.user_id).toBeNull();
    expect(epRow!.is_ephemeral).toBe(true);
    expect(epRow!.expires_at).not.toBeNull();
    expect(epRow!.name).toBe(`sandbox:${keyRow!.id}`);
  });

  it("ignores agent-supplied name/mock_response — the marker stays authoritative, no mock is stored", async () => {
    const { credential } = await mintAnonymousKey("sandbox-minimal-agent");

    const res = await h.sandboxPost(
      jsonRequest(
        SANDBOX_URL,
        // Attempt to override the name marker and inject a mock/notification.
        {
          name: "totally-not-a-marker",
          mock_response: { status: 500, body: "x", headers: {} },
          notification_url: "https://evil.example/hook",
        },
        { authorization: `Bearer ${credential}` }
      )
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    createdEndpointIds.add(body.id);

    const { data: keyRow } = await admin
      .from("api_keys")
      .select("id")
      .eq("key_hash", sha256Hex(credential))
      .single();
    const { data: epRow } = await admin
      .from("endpoints")
      .select("name, mock_response, notification_url")
      .eq("id", body.id)
      .single();
    // Name is the marker, NOT the attacker-supplied value.
    expect(epRow!.name).toBe(`sandbox:${keyRow!.id}`);
    // The sandbox is capture-only: no outbound mock or notification surface.
    expect(epRow!.mock_response).toBeNull();
    expect(epRow!.notification_url).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (3) LIST + READ + CROSS-TENANT ISOLATION (the core security property).
  // -------------------------------------------------------------------------
  it("isolates sandbox endpoints + requests between two unclaimed keys and from a real user", async () => {
    const { credential: keyA } = await mintAnonymousKey("sandbox-tenant-A");
    const { credential: keyB } = await mintAnonymousKey("sandbox-tenant-B");

    // keyA creates two endpoints.
    const a1 = await (
      await h.sandboxPost(jsonRequest(SANDBOX_URL, {}, { authorization: `Bearer ${keyA}` }))
    ).json();
    const a2 = await (
      await h.sandboxPost(jsonRequest(SANDBOX_URL, {}, { authorization: `Bearer ${keyA}` }))
    ).json();
    createdEndpointIds.add(a1.id);
    createdEndpointIds.add(a2.id);

    // keyB creates one endpoint.
    const b1 = await (
      await h.sandboxPost(jsonRequest(SANDBOX_URL, {}, { authorization: `Bearer ${keyB}` }))
    ).json();
    createdEndpointIds.add(b1.id);

    // A real user's OWNED endpoint, plus a real user's OWNED ephemeral endpoint —
    // neither must ever appear in any agent's sandbox listing.
    const { createEndpointForUser } = await import("@/lib/supabase/endpoints");
    const ownedRegular = await createEndpointForUser({ userId: realUserId, name: "owned-regular" });
    const ownedEphemeral = await createEndpointForUser({ userId: realUserId, isEphemeral: true });
    createdEndpointIds.add(ownedRegular.id);
    createdEndpointIds.add(ownedEphemeral.id);

    // LIST: keyA sees ONLY its own two endpoints.
    const listA = await (await h.sandboxGet(bearerGet(SANDBOX_URL, keyA))).json();
    const slugsA = new Set<string>(listA.endpoints.map((e: { slug: string }) => e.slug));
    expect(slugsA.size).toBe(2);
    expect(slugsA.has(a1.slug)).toBe(true);
    expect(slugsA.has(a2.slug)).toBe(true);
    expect(slugsA.has(b1.slug)).toBe(false);
    expect(slugsA.has(ownedRegular.slug)).toBe(false);
    expect(slugsA.has(ownedEphemeral.slug)).toBe(false);

    // LIST: keyB sees ONLY its own one endpoint.
    const listB = await (await h.sandboxGet(bearerGet(SANDBOX_URL, keyB))).json();
    expect(listB.endpoints).toHaveLength(1);
    expect(listB.endpoints[0].slug).toBe(b1.slug);

    // READ: seed requests on keyA's first endpoint and on keyB's endpoint.
    await insertRequest(a1.id, "/from-A");
    await insertRequest(a1.id, "/from-A-2");
    await insertRequest(b1.id, "/from-B");

    // keyA reads its OWN endpoint's requests.
    const readOwn = await h.sandboxGet(bearerGet(`${SANDBOX_URL}?slug=${a1.slug}`, keyA));
    expect(readOwn.status).toBe(200);
    const readOwnBody = await readOwn.json();
    expect(readOwnBody.slug).toBe(a1.slug);
    expect(readOwnBody.requests).toHaveLength(2);
    const paths = new Set<string>(readOwnBody.requests.map((r: { path: string }) => r.path));
    expect(paths.has("/from-A")).toBe(true);
    expect(paths.has("/from-A-2")).toBe(true);

    // CROSS-TENANT: keyA tries to read keyB's slug -> 404 (never disclosed, no rows leaked).
    const crossAgent = await h.sandboxGet(bearerGet(`${SANDBOX_URL}?slug=${b1.slug}`, keyA));
    expect(crossAgent.status).toBe(404);

    // CROSS-TENANT: keyA tries to read a real user's endpoint slug -> 404.
    const crossUserRegular = await h.sandboxGet(
      bearerGet(`${SANDBOX_URL}?slug=${ownedRegular.slug}`, keyA)
    );
    expect(crossUserRegular.status).toBe(404);
    const crossUserEphemeral = await h.sandboxGet(
      bearerGet(`${SANDBOX_URL}?slug=${ownedEphemeral.slug}`, keyA)
    );
    expect(crossUserEphemeral.status).toBe(404);

    // Sanity: keyB can read its own, and gets only its single request.
    const readB = await h.sandboxGet(bearerGet(`${SANDBOX_URL}?slug=${b1.slug}`, keyB));
    expect(readB.status).toBe(200);
    const readBBody = await readB.json();
    expect(readBBody.requests).toHaveLength(1);
    expect(readBBody.requests[0].path).toBe("/from-B");

    // A brand-new key with no endpoints lists empty (no pooling of NULL-user rows).
    const { credential: keyC } = await mintAnonymousKey("sandbox-tenant-C");
    const listC = await (await h.sandboxGet(bearerGet(SANDBOX_URL, keyC))).json();
    expect(listC.endpoints).toEqual([]);
  });

  it("404s a slug that does not exist at all", async () => {
    const { credential } = await mintAnonymousKey("sandbox-unknown-slug");
    const res = await h.sandboxGet(bearerGet(`${SANDBOX_URL}?slug=this-slug-never-existed`, credential));
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // (4) BOUNDED CAPACITY — per-key cap on concurrent sandbox endpoints.
  // -------------------------------------------------------------------------
  it("caps the number of concurrent sandbox endpoints per key (429)", async () => {
    const { credential } = await mintAnonymousKey("sandbox-cap-agent");

    // MAX_SANDBOX_ENDPOINTS_PER_KEY is 5: the first 5 succeed.
    for (let i = 0; i < 5; i++) {
      const res = await h.sandboxPost(jsonRequest(SANDBOX_URL, {}, { authorization: `Bearer ${credential}` }));
      expect(res.status).toBe(201);
      createdEndpointIds.add((await res.json()).id);
    }

    // The 6th is rejected with 429 (cap reached) rather than 201.
    const over = await h.sandboxPost(jsonRequest(SANDBOX_URL, {}, { authorization: `Bearer ${credential}` }));
    expect(over.status).toBe(429);
    expect((await over.json()).error).toMatch(/limit reached/i);
  });

  // -------------------------------------------------------------------------
  // (5) POST-CLAIM — once a key is claimed it is EVICTED from the sandbox.
  // -------------------------------------------------------------------------
  it("rejects a key once it has been claimed (defense in depth against TOCTOU)", async () => {
    const { credential, claimToken } = await mintAnonymousKey("sandbox-claim-agent");

    // While unclaimed, the sandbox works.
    const before = await h.sandboxPost(jsonRequest(SANDBOX_URL, {}, { authorization: `Bearer ${credential}` }));
    expect(before.status).toBe(201);
    createdEndpointIds.add((await before.json()).id);

    // Claim the key in-app with the real user's session token.
    const claim = await h.confirmPost(
      jsonRequest(
        "https://webhooks.cc/api/agent/auth/claim/confirm",
        { claim_token: claimToken },
        { authorization: `Bearer ${realUserAccessToken}` }
      )
    );
    expect(claim.status).toBe(200);
    expect((await claim.json()).status).toBe("claimed");

    // The key is now owned -> the sandbox must reject it (403) on BOTH verbs;
    // it should use /api/endpoints instead.
    const postAfter = await h.sandboxPost(jsonRequest(SANDBOX_URL, {}, { authorization: `Bearer ${credential}` }));
    expect(postAfter.status).toBe(403);

    const getAfter = await h.sandboxGet(bearerGet(SANDBOX_URL, credential));
    expect(getAfter.status).toBe(403);
  });
});
