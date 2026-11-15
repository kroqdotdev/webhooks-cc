import { generateKeyPairSync } from "node:crypto";
import * as jose from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Organisation ID-JAG verification (lib/agent/org-id-jag.ts) and the grant's
 * answers (org-id-jag-grant.ts), with the database, the outbound fetch and
 * the audit trail faked. The issuer's discovery document and key set are
 * served by the fake sendForward, so the real key cache runs.
 */

const APP = "https://webhooks.cc";
const PREFIX = "https://identity.example.com/issuers/";
const ISS = `${PREFIX}org-1`;
const CLIENT = "https://client.example.com/oauth/metadata.json";

const env: Record<string, unknown> = {
  AGENT_IDJAG_ORG_ISSUER_PREFIXES: [PREFIX],
  AGENT_IDJAG_MAX_AUTH_AGE_SECONDS: 3600,
  AGENT_MAX_PENDING_PER_LOGIN_HINT: 3,
  EMAIL_CAPTURE_DOMAIN: "mailhooks.cc",
  // Our own assertion key, so the suite can sign a real one of ours.
  AGENT_ASSERTION_SIGNING_KEY: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString(),
};

vi.mock("@/lib/env", () => ({
  serverEnv: () => env,
  publicEnv: () => ({ NEXT_PUBLIC_APP_URL: APP }),
}));

// Which issuers some team trusts, which jtis were seen, and what the link
// function answers.
const trusted = new Set<string>();
/** Queries of team_idjag_issuers, to see the trust cache work. */
let trustLookups = 0;
const seenJtis = new Set<string>();
let linkAnswer: Record<string, unknown> = { status: "not_member" };

function thenable<T>(value: T) {
  return { then: (resolve: (v: T) => unknown) => Promise.resolve(value).then(resolve) };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table === "team_idjag_issuers") {
        return {
          select: () => ({
            eq: (_column: string, issuer: string) => {
              trustLookups += 1;
              return thenable({ count: trusted.has(issuer) ? 1 : 0, error: null });
            },
          }),
        };
      }
      if (table === "agent_registrations") {
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({
              single: async () => ({
                data: { id, user_id: "user-1", client_name: "client.example.com" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "agent_idjag_jti") {
        return {
          insert: async (row: { jti: string; issuer: string }) => {
            const key = `${row.issuer}#${row.jti}`;
            if (seenJtis.has(key)) return { error: { code: "23505" } };
            seenJtis.add(key);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async () => ({ data: linkAnswer, error: null }),
  }),
}));

vi.mock("@/lib/supabase/inbound-domains", () => ({ isInboundDomainAddress: async () => false }));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));
const audited: { action: string; metadata?: Record<string, unknown> }[] = [];
vi.mock("@/lib/audit", () => ({
  auditAgentEvent: vi.fn(async (_request: Request, input: { action: string }) => {
    audited.push(input);
  }),
  emailDomain: () => null,
}));
// The bind notice; the email itself is built and checked in its own suite.
const notices: Record<string, unknown>[] = [];
vi.mock("./org-connect-notice", () => ({
  notifyConnectBound: vi.fn(async (input: Record<string, unknown>) => {
    notices.push(input);
  }),
}));
// The token issued once linked.
vi.mock("./registrations", async (importOriginal) => {
  const original = await importOriginal<typeof import("./registrations")>();
  return {
    ...original,
    issueClaimedAccessToken: async (registrationId: string) => ({
      accessToken: "whcc_test",
      expiresIn: 3600,
      scope: "endpoints:read",
      registration: { id: registrationId, user_id: "user-1", client_name: "client.example.com" },
    }),
  };
});
// The token endpoint's budgets: every key asked for, and which are spent.
const rateKeys: { key: string; max: number }[] = [];
const exhausted = new Set<string>();
vi.mock("@/lib/rate-limit", () => ({
  getClientIp: (request: Request) => request.headers.get("x-forwarded-for") ?? "unknown",
  rateLimitIpBucket: (ip: string) => ip,
  checkRateLimitByKeyWithInfo: async (key: string, max: number) => {
    rateKeys.push({ key, max });
    return exhausted.has(key)
      ? { response: new Response(null, { status: 429, headers: { "Retry-After": "42" } }) }
      : { response: null };
  },
}));
vi.mock("@/lib/forwarding/config", () => ({
  sendOptions: () => ({ timeoutMs: 1000, proxy: null, allowPrivate: false }),
}));

// The fake issuer: documents by URL.
const documents = new Map<string, unknown>();
const fetched: string[] = [];
vi.mock("@/lib/forwarding/send", () => ({
  sendForward: async (outgoing: { url: string }) => {
    fetched.push(outgoing.url);
    const document = documents.get(outgoing.url);
    if (document === undefined) {
      return { status: 404, excerpt: null, error: null, durationMs: 1 };
    }
    const text = typeof document === "string" ? document : JSON.stringify(document);
    return { status: 200, excerpt: text.slice(0, 1024), error: null, durationMs: 1 };
  },
}));

const { verifyOrgIdJag, looksLikeIdJag, orgIssuerCandidate, orgClientName } =
  await import("./org-id-jag");
const { orgIdJagGrant, identityRateKey, UNVERIFIED_DESCRIPTION } =
  await import("./org-id-jag-grant");
const { issuerRateKey } = await import("./token-rate-limit");
const { signAssertion } = await import("./assertion");
const { clearOrgJwksCache, discoveryUrl } = await import("./org-jwks");
const { checkOrgIssuer, checkAllowedClientIds, clearTrustedIssuerCache, issuerTrustedByAnyTeam } =
  await import("./org-issuers");
const { clearRefusalAuditGate } = await import("./refusal-audit");

let key: CryptoKey;
let publicKey: CryptoKey;
let otherKey: CryptoKey;
const KID = "key-1";

function serveIssuer(iss: string, jwks: unknown, discovery?: unknown) {
  const jwksUri = `${new URL(iss).origin}/jwks/${encodeURIComponent(iss)}`;
  documents.set(discoveryUrl(iss), discovery ?? { issuer: iss, jwks_uri: jwksUri });
  documents.set(jwksUri, jwks);
}

async function publicJwk(k: CryptoKey, kid: string) {
  return { ...(await jose.exportJWK(k)), kid, alg: "ES256", use: "sig" };
}

interface MintOptions {
  iss?: string;
  aud?: string | string[];
  alg?: string;
  kid?: string;
  signWith?: CryptoKey | Uint8Array;
  exp?: number;
  iat?: number;
  authTime?: number | null;
  email?: string;
  /** null leaves the claim out. */
  emailVerified?: unknown;
  clientId?: string;
  jti?: string;
  typ?: string;
}

async function mint(options: MintOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    client_id: options.clientId ?? CLIENT,
    email: options.email ?? "Member@Example.com",
  };
  if (options.emailVerified !== null) claims.email_verified = options.emailVerified ?? true;
  if (options.authTime !== null) claims.auth_time = options.authTime ?? now - 30;
  return new jose.SignJWT(claims)
    .setProtectedHeader({
      alg: options.alg ?? "ES256",
      typ: options.typ ?? "oauth-id-jag+jwt",
      kid: options.kid ?? KID,
    })
    .setIssuer(options.iss ?? ISS)
    .setSubject("member-sub")
    .setAudience(options.aud ?? APP)
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 60)
    .setJti(options.jti ?? crypto.randomUUID())
    .sign(options.signWith ?? key);
}

/** A token whose header and signature are written by hand (alg none). */
function unsignedToken(header: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part(header)}.${part({
    iss: ISS,
    sub: "member-sub",
    aud: APP,
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID(),
    client_id: CLIENT,
    email: "member@example.com",
    email_verified: true,
    auth_time: now,
  })}.`;
}

beforeAll(async () => {
  ({ privateKey: key, publicKey } = await jose.generateKeyPair("ES256"));
  ({ privateKey: otherKey } = await jose.generateKeyPair("ES256"));
});

beforeEach(async () => {
  env.AGENT_IDJAG_ORG_ISSUER_PREFIXES = [PREFIX];
  trusted.clear();
  trusted.add(ISS);
  documents.clear();
  fetched.length = 0;
  clearOrgJwksCache();
  clearTrustedIssuerCache();
  clearRefusalAuditGate();
  trustLookups = 0;
  audited.length = 0;
  notices.length = 0;
  serveIssuer(ISS, { keys: [await publicJwk(publicKey, KID)] });
  linkAnswer = { status: "not_member" };
  rateKeys.length = 0;
  exhausted.clear();
});

describe("verifyOrgIdJag", () => {
  test("accepts a valid assertion and lower-cases the email", async () => {
    const result = await verifyOrgIdJag(await mint(), CLIENT);
    expect(result).toMatchObject({
      ok: true,
      iss: ISS,
      sub: "member-sub",
      clientId: CLIENT,
      email: "member@example.com",
    });
  });

  test("accepts our API as the audience, and a one-element array", async () => {
    expect((await verifyOrgIdJag(await mint({ aud: `${APP}/api/` }), CLIENT)).ok).toBe(true);
    expect((await verifyOrgIdJag(await mint({ aud: [APP] }), CLIENT)).ok).toBe(true);
  });

  test("is off when no prefix is configured", async () => {
    env.AGENT_IDJAG_ORG_ISSUER_PREFIXES = [];
    expect(await verifyOrgIdJag(await mint(), CLIENT)).toEqual({
      ok: false,
      error: "feature_disabled",
    });
    expect(fetched).toEqual([]);
  });

  test("refuses every algorithm but ES256, none included, before fetching keys", async () => {
    const hs = await mint({ alg: "HS256", signWith: new Uint8Array(32) });
    expect(await verifyOrgIdJag(hs, CLIENT)).toMatchObject({ error: "unsupported_algorithm" });
    const { privateKey: rsa } = await jose.generateKeyPair("RS256");
    const rs = await mint({ alg: "RS256", signWith: rsa });
    expect(await verifyOrgIdJag(rs, CLIENT)).toMatchObject({ error: "unsupported_algorithm" });
    const none = unsignedToken({ alg: "none", typ: "oauth-id-jag+jwt" });
    expect(await verifyOrgIdJag(none, CLIENT)).toMatchObject({ error: "unsupported_algorithm" });
    expect(fetched).toEqual([]);
  });

  test("refuses a token that is not an ID-JAG", async () => {
    expect(await verifyOrgIdJag(await mint({ typ: "JWT" }), CLIENT)).toMatchObject({
      error: "invalid_token",
    });
    expect(await verifyOrgIdJag("not.a.jwt", CLIENT)).toMatchObject({ error: "invalid_token" });
  });

  test("refuses an issuer outside the prefixes, a lookalike host too", async () => {
    for (const iss of [
      "https://other.example.com/issuers/org-1",
      "https://identity.example.com.evil.test/issuers/org-1",
      PREFIX,
    ]) {
      trusted.add(iss);
      expect(await verifyOrgIdJag(await mint({ iss }), CLIENT)).toMatchObject({
        error: "issuer_not_allowed",
      });
    }
    expect(fetched).toEqual([]);
  });

  test("refuses an issuer no team trusts, without fetching anything", async () => {
    const iss = `${PREFIX}someone-else`;
    serveIssuer(iss, { keys: [await publicJwk(publicKey, KID)] });
    expect(await verifyOrgIdJag(await mint({ iss }), CLIENT)).toMatchObject({
      error: "invalid_issuer",
    });
    expect(fetched).toEqual([]);
  });

  test("refuses a wrong audience and an audience list", async () => {
    expect(
      await verifyOrgIdJag(await mint({ aud: "https://elsewhere.example" }), CLIENT)
    ).toMatchObject({ error: "invalid_audience" });
    expect(
      await verifyOrgIdJag(await mint({ aud: [APP, "https://elsewhere.example"] }), CLIENT)
    ).toMatchObject({ error: "invalid_audience" });
  });

  test("refuses an expired assertion and one issued too long ago", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      await verifyOrgIdJag(await mint({ iat: now - 600, exp: now - 300 }), CLIENT)
    ).toMatchObject({ error: "credential_expired" });
    expect(
      await verifyOrgIdJag(await mint({ iat: now - 3600, exp: now + 60 }), CLIENT)
    ).toMatchObject({ error: "credential_expired" });
  });

  test("enforces auth_time when present: stale, in the future or not a number", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await verifyOrgIdJag(await mint({ authTime: now - 7200 }), CLIENT);
    expect(stale).toMatchObject({ ok: false, error: "auth_time_too_old" });
    expect(stale.ok === false && stale.authAge).toBeGreaterThanOrEqual(7200);
    expect(await verifyOrgIdJag(await mint({ authTime: now + 600 }), CLIENT)).toMatchObject({
      error: "invalid_token",
    });
    const recent = await verifyOrgIdJag(await mint({ authTime: now - 60 }), CLIENT);
    expect(recent).toMatchObject({ ok: true, authTime: now - 60 });
  });

  test("without auth_time, accepts only an assertion living 5 minutes or less", async () => {
    const now = Math.floor(Date.now() / 1000);
    // Claude's: a minute.
    expect(await verifyOrgIdJag(await mint({ authTime: null }), CLIENT)).toMatchObject({
      ok: true,
      authTime: null,
    });
    // Exactly five minutes.
    expect(
      (await verifyOrgIdJag(await mint({ authTime: null, iat: now, exp: now + 300 }), CLIENT)).ok
    ).toBe(true);
    // A second more.
    expect(
      await verifyOrgIdJag(await mint({ authTime: null, iat: now, exp: now + 301 }), CLIENT)
    ).toMatchObject({ ok: false, error: "lifetime_too_long" });
    // A long-lived one is fine only with auth_time.
    expect((await verifyOrgIdJag(await mint({ iat: now, exp: now + 3000 }), CLIENT)).ok).toBe(true);
  });

  test("without auth_time, the jti is still single-use", async () => {
    const token = await mint({ authTime: null, jti: "no-auth-time" });
    expect((await verifyOrgIdJag(token, CLIENT)).ok).toBe(true);
    expect(await verifyOrgIdJag(token, CLIENT)).toMatchObject({ error: "replay_detected" });
  });

  test("refuses an unknown kid, refetching the key set at most once", async () => {
    // Warm the cache, then present a kid the issuer does not publish.
    expect((await verifyOrgIdJag(await mint(), CLIENT)).ok).toBe(true);
    const before = fetched.length;
    const result = await verifyOrgIdJag(await mint({ kid: "missing", signWith: otherKey }), CLIENT);
    expect(result).toMatchObject({ error: "unknown_key" });
    // Fetched within the cooldown: no refetch.
    expect(fetched.length).toBe(before);
  });

  test("refuses a signature by a key the issuer does not publish under that kid", async () => {
    expect(await verifyOrgIdJag(await mint({ signWith: otherKey }), CLIENT)).toMatchObject({
      error: "invalid_signature",
    });
  });

  test("refuses a replayed jti", async () => {
    const token = await mint({ jti: "same-jti" });
    expect((await verifyOrgIdJag(token, CLIENT)).ok).toBe(true);
    expect(await verifyOrgIdJag(token, CLIENT)).toMatchObject({ error: "replay_detected" });
  });

  test("accepts email_verified absent, refuses false and anything but true", async () => {
    expect(await verifyOrgIdJag(await mint({ emailVerified: null }), CLIENT)).toMatchObject({
      ok: true,
      email: "member@example.com",
    });
    for (const value of [false, "true", 1]) {
      expect(await verifyOrgIdJag(await mint({ emailVerified: value }), CLIENT)).toMatchObject({
        error: "missing_verified_email",
      });
    }
  });

  test("refuses an unverified or missing email", async () => {
    expect(await verifyOrgIdJag(await mint({ emailVerified: false }), CLIENT)).toMatchObject({
      error: "missing_verified_email",
    });
    expect(await verifyOrgIdJag(await mint({ email: "" }), CLIENT)).toMatchObject({
      error: "missing_verified_email",
    });
  });

  test("refuses a client_id other than the request's", async () => {
    expect(await verifyOrgIdJag(await mint(), "https://other-client.example/meta")).toMatchObject({
      error: "client_mismatch",
    });
  });

  test("refuses keys from a discovery document naming another issuer or host", async () => {
    documents.set(discoveryUrl(ISS), {
      issuer: `${PREFIX}org-2`,
      jwks_uri: "https://identity.example.com/jwks",
    });
    expect(await verifyOrgIdJag(await mint(), CLIENT)).toMatchObject({
      error: "keys_unavailable",
    });
    clearOrgJwksCache();
    documents.set(discoveryUrl(ISS), { issuer: ISS, jwks_uri: "https://keys.elsewhere.test/jwks" });
    expect(await verifyOrgIdJag(await mint(), CLIENT)).toMatchObject({
      error: "keys_unavailable",
    });
  });

  test("refuses a key set over the size cap", async () => {
    const jwk = await publicJwk(publicKey, KID);
    serveIssuer(ISS, { keys: Array.from({ length: 8 }, (_, i) => ({ ...jwk, kid: `k${i}` })) });
    expect(await verifyOrgIdJag(await mint(), CLIENT)).toMatchObject({
      error: "keys_too_large",
    });
  });

  test("reads the typ: our own assertions carry the ID-JAG typ too", async () => {
    expect(looksLikeIdJag(await mint())).toBe(true);
    expect(looksLikeIdJag(await mint({ typ: "JWT" }))).toBe(false);
    expect(looksLikeIdJag("garbage")).toBe(false);
    const ours = await signAssertion({
      registrationId: crypto.randomUUID(),
      stage: "claimed",
      expiresAt: new Date(Date.now() + 3600_000),
      email: "member@example.com",
    });
    expect(looksLikeIdJag(ours)).toBe(true);
  });
});

describe("orgIssuerCandidate", () => {
  test("names an issuer under a prefix without verifying, fetching or looking anything up", async () => {
    expect(orgIssuerCandidate(await mint({ signWith: otherKey }))).toBe(ISS);
    // Untrusted but under the prefix: still the organisation path.
    expect(orgIssuerCandidate(await mint({ iss: `${PREFIX}nobody` }))).toBe(`${PREFIX}nobody`);
    expect(fetched).toEqual([]);
  });

  test("is never our own assertion, which has the same typ", async () => {
    const ours = await signAssertion({
      registrationId: crypto.randomUUID(),
      stage: "pre_claim",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(orgIssuerCandidate(ours)).toBeNull();
    // Even with a prefix our own issuer falls under.
    env.AGENT_IDJAG_ORG_ISSUER_PREFIXES = ["https://webhooks"];
    expect(orgIssuerCandidate(ours)).toBeNull();
  });

  test("is null outside the prefixes, for garbage, or when off", async () => {
    expect(
      orgIssuerCandidate(await mint({ iss: "https://other.example.com/issuers/org-1" }))
    ).toBeNull();
    expect(orgIssuerCandidate("garbage")).toBeNull();
    env.AGENT_IDJAG_ORG_ISSUER_PREFIXES = [];
    expect(orgIssuerCandidate(await mint())).toBeNull();
  });
});

describe("the issuer's key cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("keeps the last good key set when a refetch fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await verifyOrgIdJag(await mint(), CLIENT)).ok).toBe(true);
    // The issuer goes away, and the cached set is past its five minutes.
    documents.clear();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const before = fetched.length;
    expect((await verifyOrgIdJag(await mint(), CLIENT)).ok).toBe(true);
    expect(fetched.length).toBe(before + 1);
    // The failed attempt counts for the cooldown: a made-up kid does not refetch.
    expect(
      await verifyOrgIdJag(await mint({ kid: "made-up", signWith: otherKey }), CLIENT)
    ).toMatchObject({ error: "unknown_key" });
    expect(fetched.length).toBe(before + 1);
    // The good keys still work.
    expect((await verifyOrgIdJag(await mint(), CLIENT)).ok).toBe(true);
  });

  test("a made-up kid after the cooldown, during an outage, keeps the keys", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await verifyOrgIdJag(await mint(), CLIENT)).ok).toBe(true);
    documents.clear();
    vi.setSystemTime(Date.now() + 60_000);
    expect(
      await verifyOrgIdJag(await mint({ kid: "made-up", signWith: otherKey }), CLIENT)
    ).toMatchObject({ error: "unknown_key" });
    expect((await verifyOrgIdJag(await mint(), CLIENT)).ok).toBe(true);
  });

  test("refuses a key set over the outbound fetch's 1 KB with its own code", async () => {
    const jwksUri = `${new URL(ISS).origin}/jwks/${encodeURIComponent(ISS)}`;
    documents.set(jwksUri, JSON.stringify({ keys: [], padding: "x".repeat(2000) }));
    expect(await verifyOrgIdJag(await mint(), CLIENT)).toEqual({
      ok: false,
      error: "keys_too_large",
    });
    // Cached with its code, so the next one within the minute says the same.
    expect(await verifyOrgIdJag(await mint(), CLIENT)).toEqual({
      ok: false,
      error: "keys_too_large",
    });
  });

  test("shares one fetch between concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, async () => verifyOrgIdJag(await mint(), CLIENT))
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetched.filter((url) => url === discoveryUrl(ISS))).toHaveLength(1);
    expect(fetched).toHaveLength(2);
  });
});

describe("issuerTrustedByAnyTeam", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("keeps the answer, a no too, for 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const unknown = `${PREFIX}made-up`;
    for (let i = 0; i < 5; i++) {
      expect(await issuerTrustedByAnyTeam(unknown)).toBe(false);
      expect(await issuerTrustedByAnyTeam(ISS)).toBe(true);
    }
    expect(trustLookups).toBe(2);
    // A team adds it meanwhile: other processes see it once the entry ages out.
    trusted.add(unknown);
    expect(await issuerTrustedByAnyTeam(unknown)).toBe(false);
    vi.setSystemTime(Date.now() + 30_001);
    expect(await issuerTrustedByAnyTeam(unknown)).toBe(true);
    expect(trustLookups).toBe(3);
  });

  test("made-up issuers under the prefix cost one lookup each, then none", async () => {
    for (let i = 0; i < 20; i++) {
      await verifyOrgIdJag(await mint({ iss: `${PREFIX}flood` }), CLIENT);
    }
    expect(trustLookups).toBe(1);
  });
});

describe("orgClientName", () => {
  test("names a URL client id by its host, an opaque one by itself", () => {
    expect(orgClientName(CLIENT)).toBe("client.example.com");
    expect(orgClientName("claude-connector-123")).toBe("claude-connector-123");
    expect(orgClientName("x".repeat(300))).toHaveLength(200);
  });
});

describe("orgIdJagGrant", () => {
  function tokenRequest(): Request {
    return new Request(`${APP}/api/oauth2/token`, { method: "POST" });
  }

  test("counts a verified assertion per issuer, 600 a minute, then per identity, 30", async () => {
    await orgIdJagGrant(tokenRequest(), { client_id: CLIENT }, await mint());
    expect(rateKeys).toEqual([
      { key: issuerRateKey(ISS), max: 600 },
      { key: identityRateKey(ISS, "member-sub"), max: 30 },
    ]);
    // The raw sub never goes into the key.
    expect(rateKeys[1].key).not.toContain("member-sub");
  });

  test("answers 429 once the issuer's shared budget is spent", async () => {
    exhausted.add(issuerRateKey(ISS));
    const res = await orgIdJagGrant(tokenRequest(), { client_id: CLIENT }, await mint());
    expect(res.status).toBe(429);
    expect(rateKeys).toEqual([{ key: issuerRateKey(ISS), max: 600 }]);
  });

  test("never charges the issuer's budget for an assertion whose signature fails", async () => {
    for (const assertion of [
      await mint({ signWith: otherKey }),
      await mint({ kid: "missing", signWith: otherKey }),
      await mint({ iss: `${PREFIX}not-trusted` }),
    ]) {
      await orgIdJagGrant(tokenRequest(), { client_id: CLIENT }, assertion);
    }
    expect(rateKeys).toEqual([]);
  });

  test("answers alike for every refusal before the signature holds", async () => {
    const outside = "https://other.example.com/issuers/org-1";
    const unservedIssuer = `${PREFIX}trusted-without-keys`;
    trusted.add(unservedIssuer);
    const bodies = [];
    for (const assertion of [
      await mint({ iss: `${PREFIX}not-trusted` }),
      await mint({ iss: outside }),
      await mint({ iss: unservedIssuer }),
      await mint({ signWith: otherKey }),
      await mint({ kid: "missing", signWith: otherKey }),
      await mint({ alg: "HS256", signWith: new Uint8Array(32) }),
      await mint({ typ: "JWT" }),
    ]) {
      const res = await orgIdJagGrant(tokenRequest(), { client_id: CLIENT }, assertion);
      expect(res.status).toBe(400);
      bodies.push(await res.json());
    }
    for (const body of bodies) {
      expect(body).toEqual({ error: "invalid_grant", error_description: UNVERIFIED_DESCRIPTION });
    }
  });

  test("says why once the signature holds", async () => {
    const res = await orgIdJagGrant(
      tokenRequest(),
      { client_id: CLIENT },
      await mint({ aud: "https://elsewhere.example" })
    );
    expect((await res.json()).error_description).toContain("invalid_audience");
  });

  test("answers 429 once the identity's budget is spent, before linking", async () => {
    exhausted.add(identityRateKey(ISS, "member-sub"));
    linkAnswer = { status: "unexpected" };
    const res = await orgIdJagGrant(tokenRequest(), { client_id: CLIENT }, await mint());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  test("does not count an assertion that failed verification per identity", async () => {
    await orgIdJagGrant(
      tokenRequest(),
      { client_id: CLIENT },
      await mint({ aud: "https://elsewhere.example" })
    );
    expect(rateKeys).toEqual([]);
  });

  test("points a member who has not connected yet at the team page's section", async () => {
    // The integration suite checks the full interaction_required answer.
    const { teamConnectUrl } = await import("./org-id-jag-grant");
    expect(teamConnectUrl("team-1")).toBe(`${APP}/teams/team-1#agent-sign-in`);
  });

  test("answers access_denied for someone who is not a member", async () => {
    linkAnswer = { status: "not_member" };
    const assertion = await mint();
    const res = await orgIdJagGrant(tokenRequest(), { client_id: CLIENT }, assertion);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "access_denied" });
  });

  test("answers invalid_grant for an assertion that fails a check", async () => {
    const res = await orgIdJagGrant(
      tokenRequest(),
      { client_id: CLIENT },
      await mint({ aud: "https://elsewhere.example" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("audits an unsigned refusal once a minute per address and code, counting the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const from = (ip: string) =>
        new Request(`${APP}/api/oauth2/token`, {
          method: "POST",
          headers: { "x-forwarded-for": ip },
        });
      for (let i = 0; i < 5; i++) {
        await orgIdJagGrant(
          from("192.0.2.1"),
          { client_id: CLIENT },
          await mint({ iss: `${PREFIX}not-trusted` })
        );
      }
      // Another address, and another code from the first one, each get a row.
      await orgIdJagGrant(
        from("192.0.2.2"),
        { client_id: CLIENT },
        await mint({ iss: `${PREFIX}not-trusted` })
      );
      await orgIdJagGrant(from("192.0.2.1"), { client_id: CLIENT }, await mint({ typ: "JWT" }));
      const refused = () => audited.filter((row) => row.action === "agent.registration.refused");
      expect(refused().map((row) => row.metadata?.code)).toEqual([
        "invalid_issuer",
        "invalid_issuer",
        "invalid_token",
      ]);
      // A minute on, the next row carries the four that went unwritten.
      vi.setSystemTime(Date.now() + 60_001);
      await orgIdJagGrant(
        from("192.0.2.1"),
        { client_id: CLIENT },
        await mint({ iss: `${PREFIX}not-trusted` })
      );
      expect(refused().at(-1)?.metadata).toMatchObject({ code: "invalid_issuer", suppressed: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("audits every refusal once the signature holds", async () => {
    for (let i = 0; i < 3; i++) {
      await orgIdJagGrant(
        tokenRequest(),
        { client_id: CLIENT },
        await mint({ aud: "https://elsewhere.example" })
      );
    }
    expect(audited.filter((row) => row.action === "agent.registration.refused")).toHaveLength(3);
  });

  test("emails the member when their window binds, and not on a later link", async () => {
    linkAnswer = {
      status: "linked",
      registration_id: "reg-1",
      team_id: "team-1",
      trust_id: "trust-1",
      bound: true,
      windows_closed: [],
    };
    const res = await orgIdJagGrant(tokenRequest(), { client_id: CLIENT }, await mint());
    expect(res.status).toBe(200);
    expect(notices).toEqual([
      { userId: "user-1", teamId: "team-1", clientName: "client.example.com", issuer: ISS },
    ]);
    expect(audited.map((row) => row.action)).toEqual([
      "team.idjag_connect_bound",
      "agent.token.issued",
    ]);

    linkAnswer = { ...linkAnswer, bound: false };
    await orgIdJagGrant(tokenRequest(), { client_id: CLIENT }, await mint());
    expect(notices).toHaveLength(1);
  });

  test("records the windows a connected identity's link closed", async () => {
    linkAnswer = {
      status: "linked",
      registration_id: "reg-1",
      team_id: "team-1",
      bound: false,
      windows_closed: [{ trust_id: "trust-2", team_id: "team-2" }],
    };
    const res = await orgIdJagGrant(tokenRequest(), { client_id: CLIENT }, await mint());
    expect(res.status).toBe(200);
    expect(audited).toContainEqual(
      expect.objectContaining({
        action: "team.idjag_connect_closed",
        targetId: "trust-2",
        teamId: "team-2",
        metadata: expect.objectContaining({ reason: "already_connected" }),
      })
    );
    expect(notices).toEqual([]);
  });

  test("needs a client_id", async () => {
    const res = await orgIdJagGrant(tokenRequest(), {}, await mint());
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("checkOrgIssuer", () => {
  test("takes an https URL under a prefix, exactly as written", () => {
    expect(checkOrgIssuer(`${PREFIX}abc`)).toEqual({ ok: true, issuer: `${PREFIX}abc` });
    expect(checkOrgIssuer(`${PREFIX}abc/`)).toEqual({ ok: true, issuer: `${PREFIX}abc/` });
  });

  test("refuses anything else", () => {
    for (const value of [
      undefined,
      "",
      PREFIX,
      "http://identity.example.com/issuers/abc",
      "https://identity.example.com.evil.test/issuers/abc",
      `${PREFIX}abc?x=1`,
      `${PREFIX}abc#frag`,
      `${PREFIX}../other`,
      "https://user:pw@identity.example.com/issuers/abc",
      `${PREFIX}a b`,
      `${PREFIX}${"a".repeat(600)}`,
      // Written otherwise than a parser writes it, or with escapes.
      `${PREFIX}a%2Fb`,
      `${PREFIX}a%41`,
      `${PREFIX}a\\b`,
      `${PREFIX}a{b}`,
      `${PREFIX}\u00e9`,
    ]) {
      expect(checkOrgIssuer(value).ok).toBe(false);
    }
  });

  test("checks allowed client ids", () => {
    expect(checkAllowedClientIds(undefined)).toEqual({ ok: true, clientIds: [] });
    expect(checkAllowedClientIds(["a", "a", "b"])).toEqual({ ok: true, clientIds: ["a", "b"] });
    expect(checkAllowedClientIds("a").ok).toBe(false);
    expect(checkAllowedClientIds([" a"]).ok).toBe(false);
    expect(checkAllowedClientIds(Array.from({ length: 11 }, (_, i) => `c${i}`)).ok).toBe(false);
  });
});
