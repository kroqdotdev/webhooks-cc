/**
 * @fileoverview Agent registration on auth.md v0.6: discovery, the
 * proof-of-work challenge, anonymous and ID-JAG registration, the token
 * endpoint (jwt-bearer grant) and RFC 7009 revocation, registration expiry
 * and cleanup.
 *
 * Needs the local Supabase stack with migration 00055 applied, and
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
let cleanupExpired: () => Promise<number>;
let idJagKey: CryptoKey;
let userApiKey: string;
let userSession: string;

async function mintIdJag(sub: string, overrides: { iss?: string } = {}): Promise<string> {
  const jti = randomUUID();
  createdJtis.add(jti);
  return new jose.SignJWT({
    client_id: TEST_ISS,
    email: IDJAG_EMAIL,
    email_verified: true,
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
      { iss: TEST_ISS, jwks: { keys: [jwk] }, algs: ["ES256"] },
    ]);

    routes = await loadAgentRoutes();
    const [prm, as, authMd, jwks, endpoints, apiKeys, trusted] = await Promise.all([
      import("@/app/.well-known/oauth-protected-resource/route"),
      import("@/app/.well-known/oauth-authorization-server/route"),
      import("@/app/auth.md/route"),
      import("@/app/.well-known/jwks.json/route"),
      import("@/app/api/endpoints/route"),
      import("@/app/api/api-keys/route"),
      import("@/lib/agent/trusted-providers"),
    ]);
    trusted.__resetTrustedProviders();
    prmGet = prm.GET;
    asGet = as.GET;
    authMdGet = authMd.GET;
    jwksGet = jwks.GET;
    endpointsGet = endpoints.GET;
    endpointsPost = endpoints.POST;
    apiKeysGet = apiKeys.GET;
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
      expect(as.agent_auth.identity_types_supported).toEqual(["anonymous", "identity_assertion"]);
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
      const replay = await routes.identity(
        jsonPost("/api/agent/identity", { type: "anonymous", proof_of_work: proof })
      );
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

      const serviceAuth = await routes.identity(
        jsonPost("/api/agent/identity", { type: "service_auth", login_hint: "dev@example.com" })
      );
      expect(serviceAuth.status).toBe(400);
      expect((await serviceAuth.json()).error).toBe("service_auth_not_enabled");

      const unknown = await routes.identity(jsonPost("/api/agent/identity", { type: "magic" }));
      expect((await unknown.json()).error).toBe("invalid_request");
      const notJson = await routes.identity(
        new Request(`${APP}/api/agent/identity`, { method: "POST", body: "{" })
      );
      expect((await notJson.json()).error).toBe("invalid_request");

      const claim = await routes.claim(jsonPost("/api/agent/identity/claim", {}));
      expect(claim.status).toBe(503);
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
          { grant_type: "urn:workos:agent-auth:grant-type:claim", claim_token: "clm_x" },
          400,
          "unsupported_grant_type",
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
