/**
 * @fileoverview End-to-end integration suite for the WorkOS auth.md agent
 * self-registration protocol (anonymous + verified_email OTP + ID-JAG), the
 * in-app claim ceremony, discovery documents, and revocation.
 *
 * Requires a LIVE Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from
 * .env.local) and migration 00029 applied. NOT run in CI — run with:
 *   cd apps/web && npx vitest run tests/integration/agent-auth.test.ts
 *
 * Route handlers are invoked DIRECTLY (their POST/GET exports) with a real
 * `Request`, asserting on `res.status` + `await res.json()`.
 *
 * Hermeticity: an ES256 keypair is generated locally and registered as a
 * trusted ID-JAG provider via the inline `jwks` field of AGENT_IDJAG_PROVIDERS,
 * so ID-JAG verification needs no network. The dev email transport captures the
 * OTP in-process (RESEND_API_KEY unset + non-production), so verified_email
 * needs no real delivery.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as jose from "jose";
import { createHash, randomUUID } from "node:crypto";

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

// The OTP / dev-transport path must be active: the dev transport is selected
// unless RESEND_API_KEY is set AND NODE_ENV === 'production'. Vitest sets
// NODE_ENV to 'test', but guard explicitly so a stray production env in
// .env.local cannot silently route the OTP to a real mailbox.
delete process.env.RESEND_API_KEY;
if (process.env.NODE_ENV === "production") {
  throw new Error("agent-auth integration test must not run with NODE_ENV=production");
}

// Generous per-IP registration limits so the many register/claim calls in this
// suite never trip the rate limiter. Must be set BEFORE any route/lib reads
// serverEnv() (env is parsed + cached lazily on first access). The ID-JAG
// provider env is filled in beforeAll once the keypair exists.
process.env.AGENT_REGISTER_RATE_LIMIT = "1000";
process.env.AGENT_IDJAG_RATE_LIMIT = "1000";
process.env.AGENT_REGISTER_RATE_WINDOW_MS = "3600000";

const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_ID_JAG_ISS = "https://test-idp.local";
const TEST_PASSWORD = "TestPassword123!";
const RUN = Date.now();

// Emails used by the JIT-provisioning flows; cleaned up by email in afterAll.
const OTP_EMAIL = `otp-user-${RUN}@webhooks-test.local`;
const IDJAG_EMAIL = `idjag-user-${RUN}@webhooks-test.local`;
const CLAIM_USER_EMAIL = `claim-user-${RUN}@webhooks-test.local`;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Unique X-Forwarded-For so per-IP rate limiting never crosses test cases. */
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 250}`;
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Dynamically imported route/lib handlers. Populated in beforeAll AFTER the
// env (especially AGENT_IDJAG_PROVIDERS) is set, so the first serverEnv()/
// publicEnv() parse sees the test configuration.
// ---------------------------------------------------------------------------
type Handlers = {
  registerPost: (req: Request) => Promise<Response>;
  claimPost: (req: Request) => Promise<Response>;
  confirmPost: (req: Request) => Promise<Response>;
  verifyOtpPost: (req: Request) => Promise<Response>;
  revokePost: (req: Request) => Promise<Response>;
  endpointsGet: (req: Request) => Promise<Response>;
  prmGet: () => Promise<Response>;
  asGet: () => Promise<Response>;
  authMdGet: () => Promise<Response>;
  getLastOtpForEmail: (email: string) => string | null;
  resetEmailStore: () => void;
  appUrl: string;
  resource: string;
};

let h: Handlers;

// State captured across cases for cleanup + cross-case assertions.
const createdApiKeyHashes = new Set<string>();
const createdClaimTokenHashes = new Set<string>();
const createdJtis = new Set<string>();
const createdUserIds = new Set<string>();
const claimUserEmails = new Set<string>();

let claimUserId: string;
let claimUserAccessToken: string;

// ID-JAG signing material.
let idJagPrivateKey: jose.KeyLike;
let idJagKid: string;

/** Mint an ID-JAG (or arbitrary-typ) JWT signed by the test provider key. */
async function mintIdJag(opts: {
  iss?: string;
  sub?: string;
  aud?: string;
  clientId?: string;
  email?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  jti?: string;
  typ?: string;
  expiresIn?: string;
}): Promise<string> {
  const jti = opts.jti ?? randomUUID();
  createdJtis.add(jti);
  return new jose.SignJWT({
    iss: opts.iss ?? TEST_ID_JAG_ISS,
    sub: opts.sub ?? "agent-sub-1",
    aud: opts.aud ?? h.resource,
    client_id: opts.clientId ?? TEST_ID_JAG_ISS,
    email: opts.email ?? IDJAG_EMAIL,
    email_verified: opts.emailVerified ?? true,
    phone_number_verified: opts.phoneVerified ?? false,
  })
    .setProtectedHeader({ alg: "ES256", typ: opts.typ ?? "oauth-id-jag+jwt", kid: idJagKid })
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "5m")
    .setJti(jti)
    .sign(idJagPrivateKey);
}

describe("Agent Auth (auth.md) Integration", () => {
  beforeAll(async () => {
    // 1. Generate the ES256 keypair and register the test provider BEFORE the
    //    route/lib modules are imported (env is read lazily + cached).
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    idJagPrivateKey = privateKey;
    idJagKid = "test-idjag-key-1";
    const publicJwk = await jose.exportJWK(publicKey);
    publicJwk.kid = idJagKid;
    publicJwk.alg = "ES256";

    process.env.AGENT_IDJAG_PROVIDERS = JSON.stringify([
      { iss: TEST_ID_JAG_ISS, jwks: { keys: [publicJwk] }, algs: ["ES256"] },
    ]);

    // 2. Dynamic imports now that the env is configured.
    const [
      registerMod,
      claimMod,
      confirmMod,
      verifyOtpMod,
      revokeMod,
      endpointsMod,
      prmMod,
      asMod,
      authMdMod,
      devTransport,
      trustedProviders,
      envMod,
    ] = await Promise.all([
      import("@/app/api/agent/auth/route"),
      import("@/app/api/agent/auth/claim/route"),
      import("@/app/api/agent/auth/claim/confirm/route"),
      import("@/app/api/agent/auth/claim/verify-otp/route"),
      import("@/app/api/agent/auth/revoke/route"),
      import("@/app/api/endpoints/route"),
      import("@/app/.well-known/oauth-protected-resource/route"),
      import("@/app/.well-known/oauth-authorization-server/route"),
      import("@/app/auth.md/route"),
      import("@/lib/email/dev-transport"),
      import("@/lib/agent/trusted-providers"),
      import("@/lib/env"),
    ]);

    // Ensure the trusted-provider cache reflects the env we just set.
    trustedProviders.__resetTrustedProviders();

    const appUrl = envMod.publicEnv().NEXT_PUBLIC_APP_URL;
    h = {
      registerPost: registerMod.POST,
      claimPost: claimMod.POST,
      confirmPost: confirmMod.POST,
      verifyOtpPost: verifyOtpMod.POST,
      revokePost: revokeMod.POST,
      endpointsGet: endpointsMod.GET,
      prmGet: prmMod.GET,
      asGet: asMod.GET,
      authMdGet: authMdMod.GET,
      getLastOtpForEmail: devTransport.getLastOtpForEmail,
      resetEmailStore: devTransport.__resetEmailTestStore,
      appUrl,
      resource: `${appUrl}/api/`,
    };

    // 3. A real logged-in user for the in-app claim ceremony (session token).
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: CLAIM_USER_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Claim Ceremony Test User" },
    });
    if (createErr) throw createErr;
    claimUserId = created.user!.id;
    createdUserIds.add(claimUserId);
    claimUserEmails.add(CLAIM_USER_EMAIL);

    const anonClient = createClient(SUPABASE_URL, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: signIn, error: signInErr } = await anonClient.auth.signInWithPassword({
      email: CLAIM_USER_EMAIL,
      password: TEST_PASSWORD,
    });
    if (signInErr) throw signInErr;
    claimUserAccessToken = signIn.session!.access_token;
  });

  afterAll(async () => {
    // Delete created api_keys (by key_hash), agent_claims (by token hash), and
    // jti rows, then any JIT-provisioned + explicit test users (by email).
    if (createdApiKeyHashes.size > 0) {
      await admin
        .from("api_keys")
        .delete()
        .in("key_hash", [...createdApiKeyHashes]);
    }
    if (createdClaimTokenHashes.size > 0) {
      await admin
        .from("agent_claims")
        .delete()
        .in("claim_token_hash", [...createdClaimTokenHashes]);
    }
    if (createdJtis.size > 0) {
      await admin
        .from("agent_idjag_jti")
        .delete()
        .in("jti", [...createdJtis]);
    }

    // Resolve JIT-provisioned users by email (OTP + ID-JAG flows) for deletion.
    const allEmails = new Set<string>([...claimUserEmails, OTP_EMAIL, IDJAG_EMAIL]);
    const { data: userRows } = await admin
      .from("users")
      .select("id")
      .in("email", [...allEmails]);
    for (const row of (userRows as { id: string }[] | null) ?? []) {
      createdUserIds.add(row.id);
    }
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // (1) ANONYMOUS registration
  // -------------------------------------------------------------------------
  let anonCredential: string;
  let anonClaimToken: string;

  it("anonymous: issues an unowned whcc_ key + pending claim", async () => {
    const res = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "anonymous",
        requested_credential_type: "api_key",
        client_name: "anon-test-agent",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.credential).toMatch(/^whcc_/);
    expect(body.credential_expires).toBeNull();
    expect(Array.isArray(body.scopes)).toBe(true);
    expect(body.scopes.length).toBeGreaterThan(0);
    expect(body.claim_token).toMatch(/^clm_/);
    // A short human-friendly claim code (XXXX-XXXX, unambiguous alphabet) is
    // surfaced alongside the token for the code-entry claim path.
    expect(body.user_code).toMatch(
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/
    );
    // claim_url is the in-app claim page (mirrors /cli/verify) — a browser URL.
    expect(typeof body.claim_url).toBe("string");
    expect(body.claim_url).toBe(`${h.appUrl}/agent/claim`);

    anonCredential = body.credential;
    anonClaimToken = body.claim_token;
    createdApiKeyHashes.add(sha256Hex(anonCredential));
    createdClaimTokenHashes.add(sha256Hex(anonClaimToken));

    // DB: api_keys row is agent-issued, unowned, keyed by sha256(credential).
    const { data: keyRow } = await admin
      .from("api_keys")
      .select("user_id, is_agent_issued, key_hash")
      .eq("key_hash", sha256Hex(anonCredential))
      .single();
    expect(keyRow).toBeTruthy();
    expect(keyRow!.is_agent_issued).toBe(true);
    expect(keyRow!.user_id).toBeNull();

    // DB: agent_claims row is a pending anonymous claim keyed by token hash.
    const { data: claimRow } = await admin
      .from("agent_claims")
      .select("flow, status, claim_token_hash")
      .eq("claim_token_hash", sha256Hex(anonClaimToken))
      .single();
    expect(claimRow).toBeTruthy();
    expect(claimRow!.flow).toBe("anonymous");
    expect(claimRow!.status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // (2) USE the anonymous key at the bearer boundary
  // -------------------------------------------------------------------------
  it("uses the anonymous credential to pass the bearer boundary", async () => {
    // The anonymous (unowned) key is a VALID bearer — it passes authentication
    // and so is NOT rejected with a 401. (The endpoints route itself cannot
    // list rows for a null userId, an intentional limitation documented in
    // api-auth.ts, so we assert on the auth boundary rather than a 200 body.)
    const ok = await h.endpointsGet(
      new Request("https://webhooks.cc/api/endpoints", {
        method: "GET",
        headers: { authorization: `Bearer ${anonCredential}` },
      })
    );
    expect(ok.status).not.toBe(401);

    // An unknown key is rejected at the bearer boundary with the RFC 9728
    // challenge pointing agents at the protected-resource metadata.
    const bad = await h.endpointsGet(
      new Request("https://webhooks.cc/api/endpoints", {
        method: "GET",
        headers: { authorization: "Bearer whcc_invalid" },
      })
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  });

  // -------------------------------------------------------------------------
  // (3) POLL the pending claim
  // -------------------------------------------------------------------------
  it("polls the pending anonymous claim -> pending", async () => {
    const res = await h.claimPost(
      jsonRequest("https://webhooks.cc/api/agent/auth/claim", { claim_token: anonClaimToken })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // (4) IN-APP CLAIM ceremony (session token) + auth guards
  // -------------------------------------------------------------------------
  it("claims the anonymous key in-app, rebinding it to the logged-in user", async () => {
    // confirm with a whcc_ bearer is rejected (session-only route).
    const withApiKey = await h.confirmPost(
      jsonRequest(
        "https://webhooks.cc/api/agent/auth/claim/confirm",
        { claim_token: anonClaimToken },
        { authorization: `Bearer ${anonCredential}` }
      )
    );
    expect(withApiKey.status).toBe(403);

    // confirm with no Authorization is rejected.
    const noAuth = await h.confirmPost(
      jsonRequest("https://webhooks.cc/api/agent/auth/claim/confirm", {
        claim_token: anonClaimToken,
      })
    );
    expect(noAuth.status).toBe(401);

    // confirm with the user's session access token succeeds.
    const ok = await h.confirmPost(
      jsonRequest(
        "https://webhooks.cc/api/agent/auth/claim/confirm",
        { claim_token: anonClaimToken },
        { authorization: `Bearer ${claimUserAccessToken}` }
      )
    );
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.status).toBe("claimed");

    // DB: the key is now owned + claimed; agent_claims is claimed.
    const { data: keyRow } = await admin
      .from("api_keys")
      .select("user_id, claimed_at, scopes")
      .eq("key_hash", sha256Hex(anonCredential))
      .single();
    expect(keyRow!.user_id).toBe(claimUserId);
    expect(keyRow!.claimed_at).not.toBeNull();

    const { data: claimRow } = await admin
      .from("agent_claims")
      .select("status, post_claim_scopes")
      .eq("claim_token_hash", sha256Hex(anonClaimToken))
      .single();
    expect(claimRow!.status).toBe("claimed");
    // The key's scopes are the post_claim_scopes from the claim.
    expect(keyRow!.scopes).toEqual(claimRow!.post_claim_scopes);

    // The same credential still authenticates after rebinding.
    const stillWorks = await h.endpointsGet(
      new Request("https://webhooks.cc/api/endpoints", {
        method: "GET",
        headers: { authorization: `Bearer ${anonCredential}` },
      })
    );
    expect(stillWorks.status).toBe(200);

    // Subsequent poll -> terminal "claimed" status (200). The poll endpoint
    // reports "claimed" once the key is bound; this is the terminal state the
    // SDK's waitForClaim() waits for (previously_claimed is the confirm result,
    // not the poll status).
    const poll = await h.claimPost(
      jsonRequest("https://webhooks.cc/api/agent/auth/claim", { claim_token: anonClaimToken })
    );
    expect(poll.status).toBe(200);
    const pollBody = await poll.json();
    expect(pollBody.status).toBe("claimed");
  });

  // -------------------------------------------------------------------------
  // (4b) CODE-ENTRY claim: a human claims by TYPING the short user_code.
  // -------------------------------------------------------------------------
  it("claims an anonymous key by its human-typed user_code (not the token URL)", async () => {
    // Fresh registration so we have an un-consumed pending claim + its user_code.
    const reg = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "anonymous",
        requested_credential_type: "api_key",
        client_name: "code-entry-agent",
      })
    );
    expect(reg.status).toBe(200);
    const regBody = await reg.json();
    const codeCredential: string = regBody.credential;
    const codeClaimToken: string = regBody.claim_token;
    const userCode: string = regBody.user_code;
    expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    createdApiKeyHashes.add(sha256Hex(codeCredential));
    createdClaimTokenHashes.add(sha256Hex(codeClaimToken));

    // Poll echoes the user_code while pending.
    const poll = await h.claimPost(
      jsonRequest("https://webhooks.cc/api/agent/auth/claim", { claim_token: codeClaimToken })
    );
    expect((await poll.json()).user_code).toBe(userCode);

    // Sending BOTH claim_token and user_code is rejected (exactly one required).
    const both = await h.confirmPost(
      jsonRequest(
        "https://webhooks.cc/api/agent/auth/claim/confirm",
        { claim_token: codeClaimToken, user_code: userCode },
        { authorization: `Bearer ${claimUserAccessToken}` }
      )
    );
    expect(both.status).toBe(400);

    // An unknown code -> invalid_claim_token (400).
    const unknown = await h.confirmPost(
      jsonRequest(
        "https://webhooks.cc/api/agent/auth/claim/confirm",
        { user_code: "ZZZZ-ZZZZ" },
        { authorization: `Bearer ${claimUserAccessToken}` }
      )
    );
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("invalid_claim_token");

    // Confirm by user_code with the user's session token succeeds.
    const ok = await h.confirmPost(
      jsonRequest(
        "https://webhooks.cc/api/agent/auth/claim/confirm",
        { user_code: userCode },
        { authorization: `Bearer ${claimUserAccessToken}` }
      )
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("claimed");

    // DB: the key is now owned by the claim-ceremony user.
    const { data: keyRow } = await admin
      .from("api_keys")
      .select("user_id, claimed_at")
      .eq("key_hash", sha256Hex(codeCredential))
      .single();
    expect(keyRow!.user_id).toBe(claimUserId);
    expect(keyRow!.claimed_at).not.toBeNull();

    // Re-claiming the same code -> previously_claimed (409).
    const again = await h.confirmPost(
      jsonRequest(
        "https://webhooks.cc/api/agent/auth/claim/confirm",
        { user_code: userCode },
        { authorization: `Bearer ${claimUserAccessToken}` }
      )
    );
    expect(again.status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // (5) VERIFIED_EMAIL OTP flow
  // -------------------------------------------------------------------------
  it("verified_email: issues an OTP, withholds the credential until confirmed", async () => {
    h.resetEmailStore();

    const reg = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "identity_assertion",
        assertion_type: "verified_email",
        assertion: OTP_EMAIL,
        client_name: "otp-test-agent",
      })
    );
    expect(reg.status).toBe(200);
    const regBody = await reg.json();
    expect(regBody.claim_token).toMatch(/^clm_/);
    // No credential is returned at registration for verified_email.
    expect(regBody.credential).toBeUndefined();
    const otpClaimToken: string = regBody.claim_token;
    createdClaimTokenHashes.add(sha256Hex(otpClaimToken));

    const otp = h.getLastOtpForEmail(OTP_EMAIL);
    expect(otp).toMatch(/^\d{6}$/);

    // Wrong OTP first -> 401 otp_invalid.
    const wrong = await h.verifyOtpPost(
      jsonRequest("https://webhooks.cc/api/agent/auth/claim/verify-otp", {
        claim_token: otpClaimToken,
        otp: otp === "000000" ? "111111" : "000000",
      })
    );
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toBe("otp_invalid");

    // Correct OTP -> 200 with a whcc_ credential.
    const right = await h.verifyOtpPost(
      jsonRequest("https://webhooks.cc/api/agent/auth/claim/verify-otp", {
        claim_token: otpClaimToken,
        otp: otp!,
      })
    );
    expect(right.status).toBe(200);
    const rightBody = await right.json();
    expect(rightBody.credential).toMatch(/^whcc_/);
    createdApiKeyHashes.add(sha256Hex(rightBody.credential));

    // The minted credential authenticates.
    const works = await h.endpointsGet(
      new Request("https://webhooks.cc/api/endpoints", {
        method: "GET",
        headers: { authorization: `Bearer ${rightBody.credential}` },
      })
    );
    expect(works.status).toBe(200);
  });

  it("verified_email: locks after max attempts -> otp_expired", async () => {
    h.resetEmailStore();

    const reg = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "verified_email",
        assertion: OTP_EMAIL,
      })
    );
    expect(reg.status).toBe(200);
    const otpClaimToken: string = (await reg.json()).claim_token;
    createdClaimTokenHashes.add(sha256Hex(otpClaimToken));

    const realOtp = h.getLastOtpForEmail(OTP_EMAIL)!;
    const wrongOtp = realOtp === "000000" ? "111111" : "000000";

    // max_attempts is 5. Exhaust them with wrong guesses.
    for (let i = 0; i < 5; i++) {
      const res = await h.verifyOtpPost(
        jsonRequest("https://webhooks.cc/api/agent/auth/claim/verify-otp", {
          claim_token: otpClaimToken,
          otp: wrongOtp,
        })
      );
      expect(res.status).toBe(401);
    }

    // 6th attempt — even with the CORRECT otp — is locked out.
    const locked = await h.verifyOtpPost(
      jsonRequest("https://webhooks.cc/api/agent/auth/claim/verify-otp", {
        claim_token: otpClaimToken,
        otp: realOtp,
      })
    );
    // otp_expired maps to 410 (locked).
    expect(locked.status).toBe(410);
    expect((await locked.json()).error).toBe("otp_expired");
  });

  // -------------------------------------------------------------------------
  // (6) ID-JAG (identity_assertion) flow
  // -------------------------------------------------------------------------
  it("id-jag: issues a credential bound to a JIT-provisioned user", async () => {
    const jwt = await mintIdJag({ sub: "agent-sub-idjag", email: IDJAG_EMAIL });

    const res = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: jwt,
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credential).toMatch(/^whcc_/);
    createdApiKeyHashes.add(sha256Hex(body.credential));

    // A public.users row was provisioned for the verified email.
    const { data: userRow } = await admin
      .from("users")
      .select("id")
      .ilike("email", IDJAG_EMAIL)
      .single();
    expect(userRow).toBeTruthy();
    createdUserIds.add((userRow as { id: string }).id);

    // The credential authenticates.
    const works = await h.endpointsGet(
      new Request("https://webhooks.cc/api/endpoints", {
        method: "GET",
        headers: { authorization: `Bearer ${body.credential}` },
      })
    );
    expect(works.status).toBe(200);
  });

  it("id-jag: rejects replay, tampered audience, and unknown issuer", async () => {
    // REPLAY: reuse the SAME jti twice. First succeeds, second is replay.
    const replayJti = randomUUID();
    const jwt1 = await mintIdJag({ sub: "agent-sub-replay", jti: replayJti });
    const first = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: jwt1,
      })
    );
    expect(first.status).toBe(200);
    createdApiKeyHashes.add(sha256Hex((await first.json()).credential));

    // Mint a NEW JWT reusing the same jti (mintIdJag sets the jti explicitly).
    const jwt2 = await mintIdJag({ sub: "agent-sub-replay", jti: replayJti });
    const replay = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: jwt2,
      })
    );
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("replay_detected");

    // TAMPERED AUDIENCE.
    const badAud = await mintIdJag({ sub: "agent-sub-aud", aud: "https://evil.example" });
    const audRes = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: badAud,
      })
    );
    expect(audRes.status).toBe(400);
    expect((await audRes.json()).error).toBe("invalid_audience");

    // UNKNOWN ISSUER.
    const badIss = await mintIdJag({ sub: "agent-sub-iss", iss: "https://unknown.local" });
    const issRes = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: badIss,
      })
    );
    expect(issRes.status).toBe(400);
    expect((await issRes.json()).error).toBe("invalid_issuer");
  });

  it("id-jag: rejects an unverified email even with a verified phone (no account takeover)", async () => {
    // Attack: assert a victim's address with email_verified:false but a verified
    // phone. The verify gate passes (phone), but the unverified email MUST NOT
    // resolve or provision an account, or it would be account takeover.
    const victimEmail = `victim-idjag-${randomUUID()}@example.com`;
    const jwt = await mintIdJag({
      sub: "agent-sub-unverified-email",
      email: victimEmail,
      emailVerified: false,
      phoneVerified: true,
    });
    const res = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "identity_assertion",
        assertion_type: "urn:ietf:params:oauth:token-type:id-jag",
        assertion: jwt,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_verified_email");

    // No account was provisioned for the unverified address.
    const { data: userRow } = await admin
      .from("users")
      .select("id")
      .ilike("email", victimEmail)
      .maybeSingle();
    expect(userRow).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (7) DISCOVERY documents
  // -------------------------------------------------------------------------
  it("discovery: PRM, AS metadata, and auth.md advertise the protocol", async () => {
    const prmRes = await h.prmGet();
    expect(prmRes.status).toBe(200);
    const prm = await prmRes.json();
    expect(prm.resource.endsWith("/api/")).toBe(true);

    const asRes = await h.asGet();
    expect(asRes.status).toBe(200);
    const as = await asRes.json();
    expect(as.agent_auth.identity_types_supported).toEqual([
      "anonymous",
      "verified_email",
      "identity_assertion",
    ]);
    const assertionTypes: string[] = as.agent_auth.identity_assertion.assertion_types_supported;
    expect(assertionTypes).toContain("urn:ietf:params:oauth:token-type:id-jag");
    // verified_email is an identity TYPE (asserted in identity_types_supported
    // above), NOT an assertion token format, so it must not appear here.
    expect(assertionTypes).not.toContain("verified_email");

    const mdRes = await h.authMdGet();
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("Content-Type")).toContain("text/markdown");
    const md = await mdRes.text();
    expect(md).toContain("whcc_");
    // The hosted doc describes the identity_assertion (ID-JAG) flow via its
    // canonical assertion-type URN and the verified_email flow by name.
    expect(md).toContain("urn:ietf:params:oauth:token-type:id-jag");
    expect(md).toContain("verified_email");
  });

  // -------------------------------------------------------------------------
  // (8) DISABLED / INVALID inputs
  // -------------------------------------------------------------------------
  it("rejects unsupported credential type, malformed JSON, and bad logout tokens", async () => {
    // anonymous with access_token credential -> unsupported_credential_type.
    const unsupported = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        type: "anonymous",
        requested_credential_type: "access_token",
      })
    );
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error).toBe("unsupported_credential_type");

    // Malformed JSON body -> invalid_request (400).
    const malformed = await h.registerPost(
      new Request("https://webhooks.cc/api/agent/auth", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
        body: "{ not valid json",
      })
    );
    expect(malformed.status).toBe(400);

    // Revoke with a garbage logout token -> 400.
    const badRevoke = await h.revokePost(
      jsonRequest("https://webhooks.cc/api/agent/auth/revoke", {
        logout_token: "not-a-jwt",
      })
    );
    expect(badRevoke.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // (9) SPEC compatibility: identity_type alias + raw application/jwt body
  // -------------------------------------------------------------------------
  it("accepts the `identity_type` alias for the flow selector", async () => {
    const res = await h.registerPost(
      jsonRequest("https://webhooks.cc/api/agent/auth", {
        identity_type: "anonymous",
        requested_credential_type: "api_key",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credential).toMatch(/^whcc_/);
    createdApiKeyHashes.add(sha256Hex(body.credential));
    createdClaimTokenHashes.add(sha256Hex(body.claim_token));
  });

  it("id-jag: accepts a raw application/jwt body (RFC-style, not JSON-wrapped)", async () => {
    const jwt = await mintIdJag({ sub: "agent-sub-rawjwt", email: IDJAG_EMAIL });
    const res = await h.registerPost(
      new Request("https://webhooks.cc/api/agent/auth", {
        method: "POST",
        headers: { "content-type": "application/jwt", "x-forwarded-for": nextIp() },
        body: jwt,
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credential).toMatch(/^whcc_/);
    createdApiKeyHashes.add(sha256Hex(body.credential));
  });
});
