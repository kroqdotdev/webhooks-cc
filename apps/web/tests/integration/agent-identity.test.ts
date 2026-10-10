/**
 * @fileoverview Agent registration on auth.md v0.6: discovery, the
 * proof-of-work challenge, anonymous and ID-JAG registration (auth_time,
 * the step-up for existing accounts, provider Security Event Tokens), the
 * token endpoint (jwt-bearer grant) and RFC 7009 revocation, registration
 * expiry and cleanup.
 *
 * Needs the local Supabase stack with migrations up to 00057 applied, and
 * AGENT_ASSERTION_SIGNING_KEY plus AGENT_POW_SECRET in .env.local. Run with:
 *   cd apps/web && npx vitest run --config vitest.config.ts tests/integration/agent-identity.test.ts
 *
 * An ES256 key generated here is trusted as an inline-JWKS ID-JAG provider,
 * so ID-JAG verification needs no network.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import * as jose from "jose";
import { randomUUID } from "node:crypto";
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
  nextIp,
  registerAnonymous,
  sandboxAgent,
  sha256Hex,
  type AgentRoutes,
} from "./agent-helpers";

configureAgentEnv();

const admin = adminClient();
const RUN = Date.now();
const TEST_ISS = "https://test-idp.local";
const IDJAG_EMAIL = `agent-idjag-${RUN}@webhooks-test.local`;
const USER_EMAIL = `agent-identity-user-${RUN}@webhooks-test.local`;
const PASSWORD = "TestPassword123!";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
const ID_JAG_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const REVOKED_EVENT = "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked";

const created = new Set<string>();
const createdJtis = new Set<string>();
const createdUserIds = new Set<string>();
let routes: AgentRoutes;
let prmGet: () => Promise<Response>;
let asGet: () => Promise<Response>;
let authMdGet: () => Promise<Response>;
let jwksGet: () => Promise<Response>;
let endpointsGet: (request: Request) => Promise<Response>;
let endpointsPost: (request: Request) => Promise<Response>;
let apiKeysGet: (request: Request) => Promise<Response>;
let attemptGet: (request: Request) => Promise<Response>;
let completePost: (request: Request) => Promise<Response>;
let eventPost: (request: Request) => Promise<Response>;
let cleanupExpired: () => Promise<number>;
let idJagKey: CryptoKey;
let userApiKey: string;
let userSession: string;

async function mintIdJag(
  sub: string,
  overrides: { iss?: string; email?: string; authTime?: number | null } = {}
): Promise<string> {
  const jti = randomUUID();
  createdJtis.add(jti);
  const authTime =
    overrides.authTime === undefined ? Math.floor(Date.now() / 1000) - 60 : overrides.authTime;
  return new jose.SignJWT({
    client_id: TEST_ISS,
    email: overrides.email ?? IDJAG_EMAIL,
    email_verified: true,
    ...(authTime === null ? {} : { auth_time: authTime }),
  })
    .setProtectedHeader({ alg: "ES256", typ: "oauth-id-jag+jwt", kid: "test-idjag-1" })
    .setIssuer(overrides.iss ?? TEST_ISS)
    .setSubject(sub)
    .setAudience(`${APP}/api/`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setJti(jti)
    .sign(idJagKey);
}

function presentIdJag(assertion: string): Promise<Response> {
  return routes.identity(
    jsonPost("/api/agent/identity", {
      type: "identity_assertion",
      assertion_type: ID_JAG_TYPE,
      assertion,
    })
  );
}

/** A Security Event Token from the test provider (or as overridden). */
async function mintSet(
  sub: string | null,
  overrides: {
    iss?: string;
    aud?: string;
    events?: unknown;
    key?: CryptoKey;
    iat?: number;
    typ?: string;
  } = {}
): Promise<string> {
  const jti = randomUUID();
  createdJtis.add(jti);
  const set = new jose.SignJWT({
    events: overrides.events === undefined ? { [REVOKED_EVENT]: {} } : overrides.events,
  })
    .setProtectedHeader({ alg: "ES256", typ: overrides.typ ?? "secevent+jwt", kid: "test-idjag-1" })
    .setIssuer(overrides.iss ?? TEST_ISS)
    .setAudience(overrides.aud ?? APP)
    .setIssuedAt(overrides.iat)
    .setJti(jti);
  if (sub) set.setSubject(sub);
  return set.sign(overrides.key ?? idJagKey);
}

function postSet(jwt: string, contentType = "application/secevent+jwt"): Promise<Response> {
  return eventPost(
    new Request(`${APP}/api/agent/event/notify`, {
      method: "POST",
      headers: { "content-type": contentType, "x-forwarded-for": nextIp() },
      body: jwt,
    })
  );
}

async function userIdFor(email: string): Promise<string> {
  const { data } = await admin.from("users").select("id").eq("email", email).single();
  createdUserIds.add(data!.id);
  return data!.id;
}

async function auditRows(action: string, targetId: string) {
  const { data } = await admin
    .from("audit_events")
    .select("actor_type, via, outcome, target_id, target_user_id, metadata")
    .eq("action", action)
    .eq("target_id", targetId);
  return data ?? [];
}

describe("agent identity (auth.md v0.6)", () => {
  beforeAll(async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    idJagKey = privateKey;
    const jwk = { ...(await jose.exportJWK(publicKey)), kid: "test-idjag-1", alg: "ES256" };
    process.env.AGENT_IDJAG_PROVIDERS = JSON.stringify([
      { iss: TEST_ISS, jwks: { keys: [jwk] }, algs: ["ES256"], display_name: "Test IdP" },
    ]);

    routes = await loadAgentRoutes();
    const [prm, as, authMd, jwks, endpoints, apiKeys, trusted, attempt, completeMod, event] =
      await Promise.all([
        import("@/app/.well-known/oauth-protected-resource/route"),
        import("@/app/.well-known/oauth-authorization-server/route"),
        import("@/app/auth.md/route"),
        import("@/app/.well-known/jwks.json/route"),
        import("@/app/api/endpoints/route"),
        import("@/app/api/api-keys/route"),
        import("@/lib/agent/trusted-providers"),
        import("@/app/api/agent/identity/claim/attempt/route"),
        import("@/app/api/agent/identity/claim/complete/route"),
        import("@/app/api/agent/event/notify/route"),
      ]);
    trusted.__resetTrustedProviders();
    prmGet = prm.GET;
    asGet = as.GET;
    authMdGet = authMd.GET;
    jwksGet = jwks.GET;
    endpointsGet = endpoints.GET;
    endpointsPost = endpoints.POST;
    apiKeysGet = apiKeys.GET;
    attemptGet = attempt.GET;
    completePost = completeMod.POST;
    eventPost = event.POST;
    cleanupExpired = async () => {
      const { data, error } = await admin.rpc("cleanup_expired_agent_registrations");
      if (error) throw error;
      return data as number;
    };

    // A signed-in user with a dashboard API key.
    const { data: user, error } = await admin.auth.admin.createUser({
      email: USER_EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    createdUserIds.add(user.user!.id);
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
    const { error: keyError } = await admin.from("api_keys").insert({
      user_id: user.user!.id,
      key_hash: hashApiKey(userApiKey),
      key_prefix: userApiKey.slice(0, 12),
      name: "agent-identity test key",
    });
    if (keyError) throw keyError;
  });

  afterAll(async () => {
    await cleanupRegistrations(admin, created);
    if (createdJtis.size > 0) {
      await admin
        .from("agent_idjag_jti")
        .delete()
        .in("jti", [...createdJtis]);
    }
    const { data: idjagUser } = await admin
      .from("users")
      .select("id")
      .eq("email", IDJAG_EMAIL)
      .maybeSingle();
    if (idjagUser) createdUserIds.add(idjagUser.id);
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  });

  describe("discovery", () => {
    it("publishes PRM, AS metadata with agent_auth, JWKS and /auth.md", async () => {
      const prm = await (await prmGet()).json();
      expect(prm).toMatchObject({
        resource: `${APP}/api/`,
        resource_name: "webhooks.cc",
        authorization_servers: [APP],
      });

      const as = await (await asGet()).json();
      expect(as.token_endpoint).toBe(`${APP}/api/oauth2/token`);
      expect(as.jwks_uri).toBe(`${APP}/.well-known/jwks.json`);
      // This suite trusts a test issuer, so identity_assertion is offered.
      expect(as.agent_auth.identity_types_supported).toEqual([
        "anonymous",
        "service_auth",
        "identity_assertion",
      ]);
      expect(as.grant_types_supported).toEqual([
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "urn:workos:agent-auth:grant-type:claim",
      ]);
      expect(as.agent_auth.anonymous.proof_of_work.challenge_endpoint).toBe(
        `${APP}/api/agent/identity/challenge`
      );

      const jwks = await (await jwksGet()).json();
      expect(jwks.keys).toHaveLength(1);
      expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
      expect(jwks.keys[0]).not.toHaveProperty("d");

      const md = await authMdGet();
      expect(md.headers.get("content-type")).toContain("text/markdown");
      expect(await md.text()).toContain("## Step 3: Register (anonymous)");
    });
  });

  describe("anonymous registration", () => {
    it("answers proof_of_work_required with a challenge, which then registers", async () => {
      const first = await routes.identity(jsonPost("/api/agent/identity", { type: "anonymous" }));
      expect(first.status).toBe(400);
      const required = await first.json();
      expect(required).toMatchObject({
        error: "proof_of_work_required",
        algorithm: "sha256-zero-bits",
        difficulty: 2,
        count: 2,
        challenge_endpoint: `${APP}/api/agent/identity/challenge`,
      });

      const nonces = routes.solve(required.challenge, required.difficulty, required.count);
      const second = await routes.identity(
        jsonPost("/api/agent/identity", {
          type: "anonymous",
          proof_of_work: { challenge: required.challenge, nonces },
        })
      );
      expect(second.status).toBe(200);
      created.add((await second.json()).registration_id);
    });

    it("registers with a solved challenge and returns the v0.6 response", async () => {
      const { body, proof } = await registerAnonymous(routes, created, "  my\u0007-agent  ");
      expect(body).toMatchObject({
        registration_type: "anonymous",
        pre_claim_scopes: ["webhooks:sandbox"],
        post_claim_scopes: ["webhooks:read", "webhooks:write"],
        claim_url: `${APP}/api/agent/identity/claim`,
        sandbox: {
          status: "available",
          endpoints_url: `${APP}/api/agent/sandbox/endpoints`,
          max_endpoints: 3,
          max_requests_per_endpoint: 25,
          max_requests: 100,
        },
        // The v0.7 aliases.
        id: body.registration_id,
        type: "anonymous",
        identity: { assertion: body.identity_assertion },
        claim: { token: body.claim_token },
        scopes: { pre_claim: ["webhooks:sandbox"] },
      });
      expect(body.claim_token).toMatch(/^clm_[A-Za-z0-9]{32}$/);
      const expires = Date.parse(body.assertion_expires as string);
      expect(Math.abs(expires - (Date.now() + 86_400_000))).toBeLessThan(60_000);
      expect(body.claim_token_expires).toBe(body.assertion_expires);

      const { data: row } = await admin
        .from("agent_registrations")
        .select("*")
        .eq("id", body.registration_id)
        .single();
      expect(row).toMatchObject({
        kind: "anonymous",
        user_id: null,
        client_name: "my-agent",
        claimed_at: null,
        sandbox_requests_used: 0,
        sandbox_request_limit: 100,
        claim_token_hash: sha256Hex(body.claim_token),
      });
      expect(row.pow_challenge_id).toBeTruthy();
      expect(proof.nonces).toHaveLength(2);

      const [audit] = await auditRows("agent.registration.created", body.registration_id);
      expect(audit).toMatchObject({ actor_type: "agent", outcome: "ok" });
      expect(audit.metadata).toMatchObject({ kind: "anonymous", pow_difficulty: 2, pow_count: 2 });
    });

    it("refuses a reused, tampered or unsolved challenge with a fresh one", async () => {
      const { proof } = await registerAnonymous(routes, created);
      // A replay is refused before the global rate, so it cannot use it up:
      // with the global rate at zero it still answers invalid_challenge.
      const env = routes.serverEnv();
      const originalRate = env.AGENT_ANONYMOUS_GLOBAL_RATE;
      env.AGENT_ANONYMOUS_GLOBAL_RATE = 0;
      let replay: Response;
      try {
        replay = await routes.identity(
          jsonPost("/api/agent/identity", { type: "anonymous", proof_of_work: proof })
        );
      } finally {
        env.AGENT_ANONYMOUS_GLOBAL_RATE = originalRate;
      }
      expect(replay.status).toBe(400);
      const replayBody = await replay.json();
      expect(replayBody.error).toBe("invalid_challenge");
      expect(replayBody.challenge).toMatch(/^pow1\./);

      const tampered = await routes.identity(
        jsonPost("/api/agent/identity", {
          type: "anonymous",
          proof_of_work: { challenge: `${proof.challenge}x`, nonces: proof.nonces },
        })
      );
      expect((await tampered.json()).error).toBe("invalid_challenge");

      const fresh = await (
        await routes.challenge(jsonPost("/api/agent/identity/challenge", {}))
      ).json();
      const unsolved = await routes.identity(
        jsonPost("/api/agent/identity", {
          type: "anonymous",
          proof_of_work: { challenge: fresh.challenge, nonces: ["x", "y"] },
        })
      );
      expect((await unsolved.json()).error).toBe("invalid_challenge");
      const malformed = await routes.identity(
        jsonPost("/api/agent/identity", { type: "anonymous", proof_of_work: "nope" })
      );
      expect((await malformed.json()).error).toBe("invalid_challenge");
    });

    it("refuses at the live cap without spending the challenge", async () => {
      const env = routes.serverEnv();
      const challenge = await (
        await routes.challenge(jsonPost("/api/agent/identity/challenge", {}))
      ).json();
      const proof = {
        challenge: challenge.challenge,
        nonces: routes.solve(challenge.challenge, challenge.difficulty, challenge.count),
      };
      const original = env.AGENT_MAX_LIVE_ANONYMOUS;
      env.AGENT_MAX_LIVE_ANONYMOUS = 0;
      try {
        const refused = await routes.identity(
          jsonPost("/api/agent/identity", { type: "anonymous", proof_of_work: proof })
        );
        expect(refused.status).toBe(503);
        expect(refused.headers.get("retry-after")).toBe("600");
        expect((await refused.json()).error).toBe("temporarily_unavailable");
      } finally {
        env.AGENT_MAX_LIVE_ANONYMOUS = original;
      }
      const accepted = await routes.identity(
        jsonPost("/api/agent/identity", { type: "anonymous", proof_of_work: proof })
      );
      expect(accepted.status).toBe(200);
      created.add((await accepted.json()).registration_id);
    });

    it("answers anonymous_not_enabled when switched off, and the other types", async () => {
      const env = routes.serverEnv();
      env.AGENT_ANONYMOUS_ENABLED = false;
      try {
        const off = await routes.identity(jsonPost("/api/agent/identity", { type: "anonymous" }));
        expect(off.status).toBe(400);
        expect((await off.json()).error).toBe("anonymous_not_enabled");
        const noChallenge = await routes.challenge(jsonPost("/api/agent/identity/challenge", {}));
        expect((await noChallenge.json()).error).toBe("anonymous_not_enabled");
      } finally {
        env.AGENT_ANONYMOUS_ENABLED = true;
      }

      const unknown = await routes.identity(jsonPost("/api/agent/identity", { type: "magic" }));
      expect((await unknown.json()).error).toBe("invalid_request");
      const notJson = await routes.identity(
        new Request(`${APP}/api/agent/identity`, { method: "POST", body: "{" })
      );
      expect((await notJson.json()).error).toBe("invalid_request");

      const claim = await routes.claim(jsonPost("/api/agent/identity/claim", {}));
      expect(claim.status).toBe(400);
    });
  });

  describe("token endpoint", () => {
    it("exchanges an assertion for a one-hour sandbox token", async () => {
      const { body } = await registerAnonymous(routes, created);
      const res = await routes.token(
        formPost("/api/oauth2/token", {
          grant_type: JWT_BEARER,
          assertion: body.identity_assertion,
          resource: `${APP}/api/`,
        })
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("pragma")).toBe("no-cache");
      const token = await res.json();
      expect(token).toMatchObject({ token_type: "Bearer", scope: "webhooks:sandbox" });
      expect(token.access_token).toMatch(/^whcc_/);
      expect(token.expires_in).toBeGreaterThan(3500);
      expect(token.expires_in).toBeLessThanOrEqual(3600);

      const { data: key } = await admin
        .from("api_keys")
        .select("user_id, agent_registration_id, is_agent_issued, expires_at, scopes")
        .eq("key_hash", sha256Hex(token.access_token))
        .single();
      expect(key).toMatchObject({
        user_id: null,
        agent_registration_id: body.registration_id,
        is_agent_issued: true,
        scopes: ["webhooks:sandbox"],
      });
      expect(key!.expires_at).not.toBeNull();

      const [audit] = await auditRows("agent.token.issued", body.registration_id);
      expect(audit.metadata).toMatchObject({ grant: "jwt-bearer", scope: "webhooks:sandbox" });

      // The token works on the sandbox and nowhere that needs a user.
      expect(
        (
          await routes.sandboxList(
            bearer("GET", "/api/agent/sandbox/endpoints", token.access_token)
          )
        ).status
      ).toBe(200);
      expect((await endpointsGet(bearer("GET", "/api/endpoints", token.access_token))).status).toBe(
        403
      );
    });

    it("accepts JSON, and refuses bad grants with the OAuth envelope", async () => {
      const { body } = await registerAnonymous(routes, created);
      const json = await routes.token(
        jsonPost("/api/oauth2/token", {
          grant_type: JWT_BEARER,
          assertion: body.identity_assertion,
        })
      );
      expect(json.status).toBe(200);

      const cases: Array<[Record<string, string>, number, string]> = [
        [
          { grant_type: JWT_BEARER, assertion: body.identity_assertion, resource: "https://x/" },
          400,
          "invalid_target",
        ],
        [{ grant_type: JWT_BEARER }, 400, "invalid_request"],
        [{ assertion: body.identity_assertion }, 400, "invalid_request"],
        [
          { grant_type: "urn:workos:agent-auth:grant-type:claim", claim_token: "clm_unknown" },
          400,
          "invalid_grant",
        ],
        [{ grant_type: "client_credentials" }, 400, "unsupported_grant_type"],
        [{ grant_type: JWT_BEARER, assertion: "eyJhbGciOiJFUzI1NiJ9.e30.x" }, 400, "invalid_grant"],
      ];
      for (const [fields, status, error] of cases) {
        const res = await routes.token(formPost("/api/oauth2/token", fields));
        expect(res.status, JSON.stringify(fields)).toBe(status);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const answer = await res.json();
        expect(answer.error).toBe(error);
        expect(typeof answer.error_description).toBe("string");
      }
    });

    it("keeps at most five live tokens per registration", async () => {
      const { body } = await registerAnonymous(routes, created);
      const tokens: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const exchanged = await exchange(routes, body.identity_assertion);
        tokens.push(exchanged.body.access_token as string);
      }
      const { count } = await admin
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("agent_registration_id", body.registration_id);
      expect(count).toBe(5);
      expect(
        (await routes.sandboxList(bearer("GET", "/api/agent/sandbox/endpoints", tokens[0]))).status
      ).toBe(401);
      expect(
        (await routes.sandboxList(bearer("GET", "/api/agent/sandbox/endpoints", tokens[5]))).status
      ).toBe(200);
    });

    it("refuses revoked, expired and claimed registrations", async () => {
      const revoked = await registerAnonymous(routes, created);
      await admin
        .from("agent_registrations")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", revoked.body.registration_id);
      expect((await exchange(routes, revoked.body.identity_assertion)).body.error).toBe(
        "invalid_grant"
      );

      const expired = await registerAnonymous(routes, created);
      await admin
        .from("agent_registrations")
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .eq("id", expired.body.registration_id);
      expect((await exchange(routes, expired.body.identity_assertion)).body.error).toBe(
        "invalid_grant"
      );

      // After a claim, the pre-claim assertion is useless (forced rotation).
      const claimed = await registerAnonymous(routes, created);
      const { data: user } = await admin
        .from("users")
        .select("id")
        .eq("email", USER_EMAIL)
        .single();
      await admin
        .from("agent_registrations")
        .update({ user_id: user!.id, claimed_at: new Date().toISOString() })
        .eq("id", claimed.body.registration_id);
      const refused = await exchange(routes, claimed.body.identity_assertion);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("invalid_grant");
    });
  });

  describe("revocation", () => {
    it("drops an agent token, never a dashboard key, and always answers 200", async () => {
      const agent = await sandboxAgent(routes, created);
      const res = await routes.revoke(
        formPost("/api/oauth2/revoke", { token: agent.token, token_type_hint: "access_token" })
      );
      expect(res.status).toBe(200);
      expect(
        (await routes.sandboxList(bearer("GET", "/api/agent/sandbox/endpoints", agent.token)))
          .status
      ).toBe(401);
      const [audit] = await auditRows("agent.token.revoked", agent.registrationId);
      expect(audit).toMatchObject({ actor_type: "agent", outcome: "ok" });

      // The assertion still mints a new token.
      expect((await exchange(routes, agent.assertion)).status).toBe(200);

      const dashboardKey = await routes.revoke(
        formPost("/api/oauth2/revoke", { token: userApiKey })
      );
      expect(dashboardKey.status).toBe(200);
      expect((await endpointsGet(bearer("GET", "/api/endpoints", userApiKey))).status).toBe(200);

      expect(
        (await routes.revoke(formPost("/api/oauth2/revoke", { token: "whcc_unknown" }))).status
      ).toBe(200);
      expect((await routes.revoke(formPost("/api/oauth2/revoke", {}))).status).toBe(400);
    });
  });

  describe("expiry", () => {
    it("cleanup deletes an expired registration with its tokens and endpoints", async () => {
      const agent = await sandboxAgent(routes, created);
      const createdEndpoint = await routes.sandboxCreate(
        bearer("POST", "/api/agent/sandbox/endpoints", agent.token, {})
      );
      expect(createdEndpoint.status).toBe(201);
      const endpoint = await createdEndpoint.json();
      await admin
        .from("agent_registrations")
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
        .eq("id", agent.registrationId);

      expect(await cleanupExpired()).toBeGreaterThanOrEqual(1);
      const { data: registration } = await admin
        .from("agent_registrations")
        .select("id")
        .eq("id", agent.registrationId)
        .maybeSingle();
      expect(registration).toBeNull();
      const { count: tokens } = await admin
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("key_hash", sha256Hex(agent.token));
      expect(tokens).toBe(0);
      const { data: endpointRow } = await admin
        .from("endpoints")
        .select("id")
        .eq("id", endpoint.id)
        .maybeSingle();
      expect(endpointRow).toBeNull();
      const [audit] = await auditRows("agent.registration.expired", agent.registrationId);
      expect(audit).toMatchObject({ actor_type: "system", outcome: "ok" });
    });
  });

  describe("identity_assertion (ID-JAG)", () => {
    it("registers a trusted assertion as a claimed registration", async () => {
      const sub = `agent-sub-${RUN}`;
      const res = await routes.identity(
        jsonPost("/api/agent/identity", {
          type: "identity_assertion",
          assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
          assertion: await mintIdJag(sub),
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      created.add(body.registration_id);
      expect(body).toMatchObject({
        registration_type: "identity_assertion",
        scopes: ["webhooks:read", "webhooks:write"],
      });

      // The same identity again gets the same registration.
      const again = await routes.identity(
        jsonPost("/api/agent/identity", {
          type: "identity_assertion",
          assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
          assertion: await mintIdJag(sub),
        })
      );
      expect((await again.json()).registration_id).toBe(body.registration_id);

      // Its token acts for the user: the normal API works, the sandbox does not,
      // and the account's API key list does not show it.
      const exchanged = await exchange(routes, body.identity_assertion);
      expect(exchanged.body.scope).toBe("webhooks:read webhooks:write");
      const token = exchanged.body.access_token as string;
      const createdEndpoint = await endpointsPost(
        bearer("POST", "/api/endpoints", token, { name: "from an agent" })
      );
      expect(createdEndpoint.status).toBe(200);
      const endpoint = await createdEndpoint.json();
      const { data: audit } = await admin
        .from("audit_events")
        .select("via")
        .eq("action", "endpoint.created")
        .eq("target_id", endpoint.slug);
      expect(audit?.[0]?.via).toBe("agent_token");
      const sandbox = await routes.sandboxList(
        bearer("GET", "/api/agent/sandbox/endpoints", token)
      );
      expect(sandbox.status).toBe(403);
      expect((await sandbox.json()).error).toBe("sandbox_closed");

      const { data: idjagUser } = await admin
        .from("users")
        .select("id")
        .eq("email", IDJAG_EMAIL)
        .single();
      await admin.from("endpoints").delete().eq("id", endpoint.id);
      const { count } = await admin
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("user_id", idjagUser!.id)
        .not("agent_registration_id", "is", null);
      expect(count).toBe(1);
    });

    it("answers issuer_not_enabled for an untrusted issuer", async () => {
      const res = await routes.identity(
        jsonPost("/api/agent/identity", {
          type: "identity_assertion",
          assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
          assertion: await mintIdJag("someone", { iss: "https://untrusted.example" }),
        })
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("issuer_not_enabled");

      const wrongType = await routes.identity(
        jsonPost("/api/agent/identity", { type: "identity_assertion", assertion: "x" })
      );
      expect((await wrongType.json()).error).toBe("invalid_request");
    });

    it("answers login_required without a recent auth_time", async () => {
      const sub = `stale-${RUN}`;
      const now = Math.floor(Date.now() / 1000);
      for (const authTime of [null, now - 7200]) {
        const res = await presentIdJag(await mintIdJag(sub, { authTime }));
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toMatch(
          /^AgentAuth error="login_required", max_age="3600", error_description="/
        );
        expect(await res.json()).toMatchObject({ error: "login_required", max_age: 3600 });
      }
      const { count } = await admin
        .from("agent_registrations")
        .select("id", { count: "exact", head: true })
        .eq("idjag_sub", sub);
      expect(count).toBe(0);
    });

    it("links an existing account only after its human confirms", async () => {
      const sub = `existing-${RUN}`;
      const first = await presentIdJag(await mintIdJag(sub, { email: USER_EMAIL }));
      expect(first.status).toBe(401);
      expect(first.headers.get("www-authenticate")).toMatch(
        /^AgentAuth error="interaction_required", error_description="/
      );
      const body = await first.json();
      created.add(body.registration_id);
      expect(body).toMatchObject({
        error: "interaction_required",
        registration_type: "identity_assertion",
        claim_url: `${APP}/api/agent/identity/claim`,
        post_claim_scopes: ["webhooks:read", "webhooks:write"],
        claim: { interval: 5 },
      });
      expect(body.claim_token).toMatch(/^clm_/);
      expect(body.claim.user_code).toMatch(/^\d{6}$/);
      expect(body.claim.verification_uri).toContain("/agent/claim?attempt=cat_");
      // Nothing is bound yet.
      const { data: pending } = await admin
        .from("agent_registrations")
        .select("user_id, claimed_at, attempt_login_hint")
        .eq("id", body.registration_id)
        .single();
      expect(pending).toEqual({ user_id: null, claimed_at: null, attempt_login_hint: USER_EMAIL });

      // The registration keeps its email: /claim cannot point it at someone else.
      const elsewhere = await routes.claim(
        jsonPost("/api/agent/identity/claim", {
          claim_token: body.claim_token,
          email: `someone-else-${RUN}@webhooks-test.local`,
        })
      );
      expect((await elsewhere.json()).error).toBe("invalid_login_hint");

      // Presenting the identity again re-issues the ceremony on the same
      // registration; the earlier claim token stops working.
      const again = await presentIdJag(await mintIdJag(sub, { email: USER_EMAIL }));
      expect(again.status).toBe(401);
      const second = await again.json();
      expect(second.registration_id).toBe(body.registration_id);
      expect(second.claim_token).not.toBe(body.claim_token);
      const stale = await routes.token(
        formPost("/api/oauth2/token", { grant_type: CLAIM_GRANT, claim_token: body.claim_token })
      );
      expect((await stale.json()).error).toBe("invalid_grant");

      // The claim page names the provider from the trust list.
      const attempt = new URL(second.claim.verification_uri).searchParams.get("attempt")!;
      const view = await attemptGet(
        bearer("GET", `/api/agent/identity/claim/attempt?attempt=${attempt}`, userSession)
      );
      expect(await view.json()).toMatchObject({
        kind: "identity_assertion",
        provider: "Test IdP",
        emailMatches: true,
        state: "pending",
      });

      const done = await completePost(
        bearer("POST", "/api/agent/identity/claim/complete", userSession, {
          claim_attempt_token: attempt,
          user_code: second.claim.user_code,
        })
      );
      expect(done.status).toBe(200);
      const collected = await routes.token(
        formPost("/api/oauth2/token", { grant_type: CLAIM_GRANT, claim_token: second.claim_token })
      );
      expect(collected.status).toBe(200);
      const tokens = await collected.json();
      expect(tokens.scope).toBe("webhooks:read webhooks:write");
      const userId = await userIdFor(USER_EMAIL);
      const { data: linkedRow } = await admin
        .from("agent_registrations")
        .select("user_id, claimed_at")
        .eq("id", body.registration_id)
        .single();
      expect(linkedRow?.user_id).toBe(userId);

      // From now on the identity registers directly, to the same delegation.
      const linked = await presentIdJag(await mintIdJag(sub, { email: USER_EMAIL }));
      expect(linked.status).toBe(200);
      const linkedBody = await linked.json();
      expect(linkedBody.registration_id).toBe(body.registration_id);
      expect((await exchange(routes, linkedBody.identity_assertion)).status).toBe(200);
    });
  });

  describe("security events (RFC 8935)", () => {
    it("revokes an identity's registration and tokens; the next link needs its human", async () => {
      const sub = `set-${RUN}`;
      const email = `agent-set-${RUN}@webhooks-test.local`;
      const res = await presentIdJag(await mintIdJag(sub, { email }));
      expect(res.status).toBe(200);
      const body = await res.json();
      created.add(body.registration_id);
      await userIdFor(email);
      expect((await exchange(routes, body.identity_assertion)).status).toBe(200);

      const set = await mintSet(sub);
      const accepted = await postSet(set);
      expect(accepted.status).toBe(202);
      expect(await accepted.text()).toBe("");

      const { data: row } = await admin
        .from("agent_registrations")
        .select("revoked_at")
        .eq("id", body.registration_id)
        .single();
      expect(row?.revoked_at).not.toBeNull();
      const { count } = await admin
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("agent_registration_id", body.registration_id);
      expect(count).toBe(0);
      expect((await exchange(routes, body.identity_assertion)).body.error).toBe("invalid_grant");
      const audit = await auditRows("agent.registration.revoked", body.registration_id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_type: "system",
        metadata: { kind: "identity_assertion", source: "security_event", issuer: TEST_ISS },
      });

      // The account exists now, so the identity needs its human again.
      const again = await presentIdJag(await mintIdJag(sub, { email }));
      expect(again.status).toBe(401);
      const againBody = await again.json();
      created.add(againBody.registration_id);
      expect(againBody.error).toBe("interaction_required");
      expect(againBody.registration_id).not.toBe(body.registration_id);

      // The same SET again is acknowledged without being processed again: the
      // identity's new registration stays.
      expect((await postSet(set)).status).toBe(202);
      const { data: kept } = await admin
        .from("agent_registrations")
        .select("revoked_at")
        .eq("id", againBody.registration_id)
        .single();
      expect(kept?.revoked_at).toBeNull();
    });

    it("ignores unknown events and refuses SETs it cannot trust", async () => {
      // The typ may carry the application/ prefix (RFC 7515 4.1.9).
      const unknown = await mintSet(`nobody-${RUN}`, {
        events: { "urn:x": {} },
        typ: "application/secevent+jwt",
      });
      expect((await postSet(unknown)).status).toBe(202);

      const { privateKey: otherKey } = await jose.generateKeyPair("ES256");
      const cases: [Promise<Response>, string][] = [
        [postSet(await mintSet(`x-${RUN}`), "application/json"), "invalid_request"],
        [
          postSet(await mintSet(`x-${RUN}`, { iss: "https://untrusted.example" })),
          "invalid_issuer",
        ],
        [
          postSet(await mintSet(`x-${RUN}`, { aud: "https://elsewhere.example" })),
          "invalid_audience",
        ],
        [postSet(await mintSet(`x-${RUN}`, { key: otherKey })), "invalid_key"],
        [
          postSet(await mintSet(`x-${RUN}`, { iat: Math.floor(Date.now() / 1000) - 2 * 86400 })),
          "invalid_request",
        ],
        [postSet(await mintSet(`x-${RUN}`, { events: null })), "invalid_request"],
        [postSet(await mintSet(null)), "invalid_request"],
        [postSet(await mintSet(`x-${RUN}`, { typ: "JWT" })), "invalid_request"],
        [postSet("not-a-jwt"), "invalid_request"],
      ];
      for (const [pending, err] of cases) {
        const res = await pending;
        expect(res.status).toBe(400);
        expect((await res.json()).err).toBe(err);
      }

      // Oversize and streamed without a Content-Length: refused while reading.
      const streamed = await eventPost(
        new Request(`${APP}/api/agent/event/notify`, {
          method: "POST",
          headers: { "content-type": "application/secevent+jwt", "x-forwarded-for": nextIp() },
          body: new ReadableStream({
            start(controller) {
              for (let i = 0; i < 40; i++) controller.enqueue(new Uint8Array(1024).fill(97));
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit)
      );
      expect(streamed.status).toBe(400);
      expect(await streamed.json()).toEqual({
        err: "invalid_request",
        description: "The SET is too large.",
      });
    });
  });

  describe("API keys", () => {
    it("the account's key list leaves agent tokens out", async () => {
      const { data: user } = await admin
        .from("users")
        .select("id")
        .eq("email", USER_EMAIL)
        .single();
      const agent = await registerAnonymous(routes, created);
      await admin
        .from("agent_registrations")
        .update({ user_id: user!.id, claimed_at: new Date().toISOString() })
        .eq("id", agent.body.registration_id);
      await admin.from("api_keys").insert({
        user_id: user!.id,
        key_hash: sha256Hex(`whcc_agent_${RUN}`),
        key_prefix: "whcc_agent_x",
        name: "Agent token (test)",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        is_agent_issued: true,
        agent_registration_id: agent.body.registration_id,
      });
      const res = await apiKeysGet(bearer("GET", "/api/api-keys", userSession));
      const keys = (await res.json()) as Array<{ name: string }>;
      expect(keys.map((key) => key.name)).toEqual(["agent-identity test key"]);
    });
  });
});
