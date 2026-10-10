/**
 * @fileoverview The claim ceremony (auth.md v0.6, Step 4): attempts, the
 * claim page's session routes, the claim grant, adoption of sandbox
 * endpoints, service_auth registration, and connected agents.
 *
 * Needs the local Supabase stack with migrations 00055 and 00056, and the
 * signing key and PoW secret in .env.local. Run with:
 *   cd apps/web && npx vitest run --config vitest.config.ts tests/integration/agent-claim.test.ts
 *
 * Claim polls are paced at one per 5 seconds per claim token, so a few cases
 * wait between polls.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import * as jose from "jose";
import {
  adminClient,
  APP,
  bearer,
  cleanupRegistrations,
  configureAgentEnv,
  exchange,
  formPost,
  jsonPost,
  loadAgentRoutes,
  registerAnonymous,
  sandboxAgent,
  type AgentRoutes,
} from "./agent-helpers";

delete process.env.RESEND_API_KEY;
configureAgentEnv();

const admin = adminClient();
const RUN = Date.now();
const PASSWORD = "TestPassword123!";
const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";

type Handler = (request: Request) => Promise<Response>;
type Human = { id: string; email: string; session: string };

const created = new Set<string>();
const humans: Human[] = [];
let routes: AgentRoutes;
let attemptGet: Handler;
let completePost: Handler;
let denyPost: Handler;
let registrationsGet: Handler;
let registrationDelete: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
let endpointsGet: Handler;
let lastMessage: (email: string) => { subject: string; text: string } | null;
let alice: Human;
let bob: Human;

async function human(label: string): Promise<Human> {
  const email = `agent-claim-${label}-${RUN}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  const anon = createClient(process.env.SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInError) throw signInError;
  const result = { id: data.user!.id, email, session: signIn.session!.access_token };
  humans.push(result);
  return result;
}

async function startClaim(claimToken: string, email?: string) {
  const res = await routes.claim(
    jsonPost(
      "/api/agent/identity/claim",
      email ? { claim_token: claimToken, email } : { claim_token: claimToken }
    )
  );
  return { status: res.status, body: await res.json() };
}

function attemptToken(verificationUri: string): string {
  return new URL(verificationUri).searchParams.get("attempt")!;
}

async function readAttempt(who: Human, attempt: string) {
  const res = await attemptGet(
    bearer("GET", `/api/agent/identity/claim/attempt?attempt=${attempt}`, who.session)
  );
  return { status: res.status, body: await res.json() };
}

async function complete(who: Human | string, attempt: string, code: string) {
  const token = typeof who === "string" ? who : who.session;
  const res = await completePost(
    bearer("POST", "/api/agent/identity/claim/complete", token, {
      claim_attempt_token: attempt,
      user_code: code,
    })
  );
  return { status: res.status, body: await res.json() };
}

/** Polls the claim grant, waiting out the 5-second pace per claim token. */
const lastPoll = new Map<string, number>();
async function poll(claimToken: string) {
  const since = Date.now() - (lastPoll.get(claimToken) ?? 0);
  if (since < 5_100) await new Promise((resolve) => setTimeout(resolve, 5_100 - since));
  lastPoll.set(claimToken, Date.now());
  const res = await routes.token(
    formPost("/api/oauth2/token", { grant_type: CLAIM_GRANT, claim_token: claimToken })
  );
  return { status: res.status, body: await res.json() };
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe("agent claim ceremony", () => {
  beforeAll(async () => {
    routes = await loadAgentRoutes();
    const [attempt, completeMod, deny, registrations, registration, endpoints, dev] =
      await Promise.all([
        import("@/app/api/agent/identity/claim/attempt/route"),
        import("@/app/api/agent/identity/claim/complete/route"),
        import("@/app/api/agent/identity/claim/deny/route"),
        import("@/app/api/agent/registrations/route"),
        import("@/app/api/agent/registrations/[id]/route"),
        import("@/app/api/endpoints/route"),
        import("@/lib/email/dev-transport"),
      ]);
    attemptGet = attempt.GET;
    completePost = completeMod.POST;
    denyPost = deny.POST;
    registrationsGet = registrations.GET;
    registrationDelete = registration.DELETE;
    endpointsGet = endpoints.GET;
    lastMessage = dev.getLastMessageForEmail;
    alice = await human("alice");
    bob = await human("bob");
  });

  afterAll(async () => {
    await cleanupRegistrations(admin, created);
    for (const who of humans) {
      await admin.auth.admin.deleteUser(who.id).catch(() => {});
    }
  });

  it("connects an anonymous agent: attempt, page, code, adoption, claim grant", async () => {
    const agent = await sandboxAgent(routes, created, "claim-agent");
    const endpoint = await (
      await routes.sandboxCreate(bearer("POST", "/api/agent/sandbox/endpoints", agent.token, {}))
    ).json();
    for (const path of ["/one", "/two"]) {
      await admin.rpc("capture_webhook", {
        p_slug: endpoint.slug,
        p_method: "POST",
        p_path: path,
        p_headers: {},
        p_body: "{}",
        p_query_params: {},
        p_content_type: "application/json",
        p_ip: "203.0.113.4",
        p_received_at: new Date().toISOString(),
      });
    }
    const claimToken = agent.claimToken;

    // 4a. The agent starts an attempt naming Alice.
    const started = await startClaim(claimToken, alice.email.toUpperCase());
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      registration_id: agent.registrationId,
      status: "initiated",
      claim_attempt: { interval: 5 },
    });
    expect(started.body.claim_attempt_id).toMatch(/^cla_/);
    expect(started.body.claim_attempt.user_code).toMatch(/^\d{6}$/);
    expect(started.body.claim_attempt.expires_in).toBeGreaterThan(890);
    expect(started.body.claim_attempt.expires_in).toBeLessThanOrEqual(900);
    expect(started.body.claim_attempt.verification_uri).toMatch(
      new RegExp(`^${APP}/agent/claim\\?attempt=cat_[A-Za-z0-9]{32}$`)
    );
    const attempt = attemptToken(started.body.claim_attempt.verification_uri);
    const code: string = started.body.claim_attempt.user_code;

    // 4c. Pending, then paced.
    expect((await poll(claimToken)).body.error).toBe("authorization_pending");
    const fast = await routes.token(
      formPost("/api/oauth2/token", { grant_type: CLAIM_GRANT, claim_token: claimToken })
    );
    expect((await fast.json()).error).toBe("slow_down");
    lastPoll.set(claimToken, Date.now());

    // The page, for Alice and for Bob.
    const view = await readAttempt(alice, attempt);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      state: "pending",
      clientName: "claim-agent",
      kind: "anonymous",
      emailMatches: true,
      firstAgent: true,
      codesLeft: 5,
      endpoints: [{ slug: endpoint.slug, requestCount: 2 }],
    });
    expect(view.body.requestedFor).toMatch(/^a\*\*\*@webhooks-test\.local$/);
    const bobView = await readAttempt(bob, attempt);
    expect(bobView.body).toMatchObject({ emailMatches: false, signedInAs: bob.email });

    // Bob cannot complete it, and does not use up a try.
    expect((await complete(bob, attempt, code)).body.error).toBe("wrong_account");
    const wrong = await complete(alice, attempt, wrongCode(code));
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: "wrong_code", remaining: 4 });

    // An API key or an agent token cannot complete a claim.
    expect((await complete(agent.token, attempt, code)).status).toBe(403);

    // Alice connects it.
    const done = await complete(alice, attempt, ` ${code.slice(0, 3)}-${code.slice(3)} `);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ status: "connected", adopted: [endpoint.slug], firstAgent: true });
    expect(lastMessage(alice.email)?.subject).toBe(
      "An agent was connected to your webhooks.cc account"
    );
    expect(lastMessage(alice.email)?.text).toContain(endpoint.slug);

    // Adopted: Alice's endpoint, with its requests.
    const { data: adopted } = await admin
      .from("endpoints")
      .select("user_id, is_ephemeral, expires_at, agent_registration_id")
      .eq("id", endpoint.id)
      .single();
    expect(adopted).toEqual({
      user_id: alice.id,
      is_ephemeral: false,
      expires_at: null,
      agent_registration_id: null,
    });
    const { data: requests } = await admin
      .from("requests")
      .select("user_id")
      .eq("endpoint_id", endpoint.id);
    expect(requests?.map((row) => row.user_id)).toEqual([alice.id, alice.id]);

    // The pre-claim token and assertion are dead; the link is used.
    expect(
      (await routes.sandboxList(bearer("GET", "/api/agent/sandbox/endpoints", agent.token))).status
    ).toBe(401);
    expect((await exchange(routes, agent.assertion)).body.error).toBe("invalid_grant");
    expect((await readAttempt(alice, attempt)).status).toBe(404);

    // The claim grant collects account credentials once.
    const collected = await poll(claimToken);
    expect(collected.status).toBe(200);
    expect(collected.body).toMatchObject({
      token_type: "Bearer",
      scope: "webhooks:read webhooks:write",
    });
    const claims = jose.decodeJwt(collected.body.identity_assertion);
    expect(claims).toMatchObject({
      sub: agent.registrationId,
      stage: "claimed",
      email: alice.email,
      email_verified: true,
    });
    expect((await poll(claimToken)).body.error).toBe("invalid_grant");

    const accountToken: string = collected.body.access_token;
    const listed = await (await endpointsGet(bearer("GET", "/api/endpoints", accountToken))).json();
    expect(listed.owned.map((e: { slug: string }) => e.slug)).toContain(endpoint.slug);
    expect((await exchange(routes, collected.body.identity_assertion)).status).toBe(200);

    // Audit trail.
    const { data: audit } = await admin
      .from("audit_events")
      .select("action, actor_type, actor_user_id, metadata")
      .eq("target_id", agent.registrationId)
      .in("action", ["agent.claim.requested", "agent.claim.confirmed", "agent.claim.refused"]);
    expect(audit?.find((row) => row.action === "agent.claim.confirmed")).toMatchObject({
      actor_type: "user",
      actor_user_id: alice.id,
      metadata: { adopted_endpoints: 1 },
    });
    expect(audit?.filter((row) => row.action === "agent.claim.refused")).toHaveLength(2);

    // Connected agents: listed, then disconnected.
    const agents = await (
      await registrationsGet(bearer("GET", "/api/agent/registrations", alice.session))
    ).json();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: agent.registrationId, clientName: "claim-agent" });
    expect(
      (await registrationsGet(bearer("GET", "/api/agent/registrations", accountToken))).status
    ).toBe(403);
    const bobRevoke = await registrationDelete(
      bearer("DELETE", `/api/agent/registrations/${agent.registrationId}`, bob.session),
      { params: Promise.resolve({ id: agent.registrationId }) }
    );
    expect(bobRevoke.status).toBe(404);
    const revoke = await registrationDelete(
      bearer("DELETE", `/api/agent/registrations/${agent.registrationId}`, alice.session),
      { params: Promise.resolve({ id: agent.registrationId }) }
    );
    expect(revoke.status).toBe(204);
    expect((await endpointsGet(bearer("GET", "/api/endpoints", accountToken))).status).toBe(401);
    expect((await exchange(routes, collected.body.identity_assertion)).body.error).toBe(
      "invalid_grant"
    );
    const after = await (
      await registrationsGet(bearer("GET", "/api/agent/registrations", alice.session))
    ).json();
    expect(after).toEqual([]);
    // The endpoint it brought stays Alice's.
    const { data: kept } = await admin
      .from("endpoints")
      .select("user_id")
      .eq("id", endpoint.id)
      .single();
    expect(kept?.user_id).toBe(alice.id);
    await admin.from("endpoints").delete().eq("id", endpoint.id);
  });

  it("replaces attempts, caps them, and locks after five wrong codes", async () => {
    const { body } = await registerAnonymous(routes, created, "attempts");
    const first = await startClaim(body.claim_token, alice.email);
    const second = await startClaim(body.claim_token, alice.email);
    const firstAttempt = attemptToken(first.body.claim_attempt.verification_uri);
    const secondAttempt = attemptToken(second.body.claim_attempt.verification_uri);
    expect((await readAttempt(alice, firstAttempt)).status).toBe(404);
    expect((await complete(alice, firstAttempt, first.body.claim_attempt.user_code)).status).toBe(
      404
    );

    for (let i = 0; i < 5; i += 1) {
      await complete(alice, secondAttempt, wrongCode(second.body.claim_attempt.user_code));
    }
    expect((await readAttempt(alice, secondAttempt)).body.state).toBe("locked");
    const locked = await complete(alice, secondAttempt, second.body.claim_attempt.user_code);
    expect(locked.body.error).toBe("locked");
    expect((await poll(body.claim_token)).body.error).toBe("expired_token");

    // Attempts three to ten work; the eleventh is refused.
    for (let i = 3; i <= 10; i += 1) {
      expect((await startClaim(body.claim_token, alice.email)).status).toBe(200);
    }
    const eleventh = await startClaim(body.claim_token, alice.email);
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error).toBe("too_many_attempts");
  });

  it("answers access_denied after Decline, and expired_token after the code runs out", async () => {
    const { body } = await registerAnonymous(routes, created, "deny");
    const started = await startClaim(body.claim_token, alice.email);
    const attempt = attemptToken(started.body.claim_attempt.verification_uri);
    const bobDeny = await denyPost(
      bearer("POST", "/api/agent/identity/claim/deny", bob.session, {
        claim_attempt_token: attempt,
      })
    );
    expect(bobDeny.status).toBe(403);
    const deny = await denyPost(
      bearer("POST", "/api/agent/identity/claim/deny", alice.session, {
        claim_attempt_token: attempt,
      })
    );
    expect(deny.status).toBe(200);
    expect((await poll(body.claim_token)).body.error).toBe("access_denied");
    expect((await readAttempt(alice, attempt)).body.state).toBe("denied");
    expect((await complete(alice, attempt, started.body.claim_attempt.user_code)).body.error).toBe(
      "denied"
    );

    const again = await startClaim(body.claim_token, alice.email);
    const againAttempt = attemptToken(again.body.claim_attempt.verification_uri);
    await admin
      .from("agent_registrations")
      .update({ attempt_expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", body.registration_id);
    expect((await poll(body.claim_token)).body.error).toBe("expired_token");
    expect((await readAttempt(alice, againAttempt)).body.state).toBe("expired");
    const late = await complete(alice, againAttempt, again.body.claim_attempt.user_code);
    expect(late.status).toBe(410);

    // The registration itself expired: claim_expired.
    await admin
      .from("agent_registrations")
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", body.registration_id);
    const gone = await startClaim(body.claim_token, alice.email);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe("claim_expired");
  });

  it("refuses bad claim requests", async () => {
    const { body } = await registerAnonymous(routes, created, "bad");
    expect((await startClaim(body.claim_token)).body.error).toBe("invalid_request");
    expect((await startClaim(body.claim_token, "x@mailhooks.cc")).body.error).toBe(
      "invalid_login_hint"
    );
    expect((await startClaim(body.claim_token, "not an email")).body.error).toBe(
      "invalid_login_hint"
    );
    const unknown = await startClaim("clm_unknownunknownunknownunknownunk", alice.email);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe("invalid_claim_token");
    expect((await readAttempt(alice, "cat_nope")).status).toBe(404);
  });

  it("caps connected agents per account", async () => {
    const carol = await human("carol");
    const rows = Array.from({ length: 10 }, () => ({
      kind: "anonymous" as const,
      user_id: carol.id,
      claimed_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
    }));
    const { data: filler, error } = await admin
      .from("agent_registrations")
      .insert(rows)
      .select("id");
    if (error) throw error;
    for (const row of filler ?? []) created.add(row.id);

    const { body } = await registerAnonymous(routes, created, "eleventh");
    const started = await startClaim(body.claim_token, carol.email);
    const attempt = attemptToken(started.body.claim_attempt.verification_uri);
    expect((await readAttempt(carol, attempt)).body.firstAgent).toBe(false);
    const refused = await complete(carol, attempt, started.body.claim_attempt.user_code);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("too_many_agents");
  });

  describe("service_auth", () => {
    it("registers for a named human, who connects it; no sandbox before that", async () => {
      const res = await routes.identity(
        jsonPost("/api/agent/identity", {
          type: "service_auth",
          login_hint: bob.email,
          client_name: "svc-agent",
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      created.add(body.registration_id);
      expect(body).toMatchObject({
        registration_type: "service_auth",
        claim_url: `${APP}/api/agent/identity/claim`,
        post_claim_scopes: ["webhooks:read", "webhooks:write"],
        claim: { interval: 5 },
      });
      expect(body.identity_assertion).toBeUndefined();
      expect(body.claim.user_code).toMatch(/^\d{6}$/);

      // A re-issue keeps the bound email; another email is refused.
      const other = await startClaim(body.claim_token, alice.email);
      expect(other.body.error).toBe("invalid_login_hint");
      const reissued = await startClaim(body.claim_token);
      expect(reissued.status).toBe(200);
      const attempt = attemptToken(reissued.body.claim_attempt.verification_uri);

      expect((await readAttempt(alice, attempt)).body.emailMatches).toBe(false);
      const done = await complete(bob, attempt, reissued.body.claim_attempt.user_code);
      expect(done.body).toEqual({ status: "connected", adopted: [], firstAgent: true });
      const collected = await poll(body.claim_token);
      expect(collected.status).toBe(200);
      expect(jose.decodeJwt(collected.body.identity_assertion).email).toBe(bob.email);
    });

    it("refuses capture-domain emails and too many pending registrations per email", async () => {
      const capture = await routes.identity(
        jsonPost("/api/agent/identity", { type: "service_auth", login_hint: "a@mailhooks.cc" })
      );
      expect((await capture.json()).error).toBe("invalid_login_hint");

      const target = `pending-${RUN}@webhooks-test.local`;
      for (let i = 0; i < 3; i += 1) {
        const res = await routes.identity(
          jsonPost("/api/agent/identity", { type: "service_auth", login_hint: target })
        );
        expect(res.status).toBe(200);
        created.add((await res.json()).registration_id);
      }
      const fourth = await routes.identity(
        jsonPost("/api/agent/identity", { type: "service_auth", login_hint: target })
      );
      expect(fourth.status).toBe(429);
    });
  });
});
