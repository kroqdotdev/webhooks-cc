import * as jose from "jose";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

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
};

vi.mock("@/lib/env", () => ({
  serverEnv: () => env,
  publicEnv: () => ({ NEXT_PUBLIC_APP_URL: APP }),
}));

// Which issuers some team trusts, which jtis were seen, and what the link
// function answers.
const trusted = new Set<string>();
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
            eq: (_column: string, issuer: string) =>
              thenable({ count: trusted.has(issuer) ? 1 : 0, error: null }),
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
vi.mock("@/lib/audit", () => ({ auditAgentEvent: vi.fn(async () => {}), emailDomain: () => null }));
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

const { verifyOrgIdJag, looksLikeIdJag } = await import("./org-id-jag");
const { orgIdJagGrant } = await import("./org-id-jag-grant");
const { clearOrgJwksCache, discoveryUrl } = await import("./org-jwks");
const { checkOrgIssuer, checkAllowedClientIds } = await import("./org-issuers");

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
  emailVerified?: boolean;
  clientId?: string;
  jti?: string;
  typ?: string;
}

async function mint(options: MintOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    client_id: options.clientId ?? CLIENT,
    email: options.email ?? "Member@Example.com",
    email_verified: options.emailVerified ?? true,
  };
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
  serveIssuer(ISS, { keys: [await publicJwk(publicKey, KID)] });
  linkAnswer = { status: "not_member" };
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

  test("refuses a missing or stale auth_time", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyOrgIdJag(await mint({ authTime: null }), CLIENT)).toMatchObject({
      error: "auth_time_missing",
    });
    const stale = await verifyOrgIdJag(await mint({ authTime: now - 7200 }), CLIENT);
    expect(stale).toMatchObject({ ok: false, error: "auth_time_too_old" });
    expect(stale.ok === false && stale.authAge).toBeGreaterThanOrEqual(7200);
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
      error: "keys_unavailable",
    });
  });

  test("tells an ID-JAG from our own assertions by its typ", async () => {
    expect(looksLikeIdJag(await mint())).toBe(true);
    expect(looksLikeIdJag(await mint({ typ: "JWT" }))).toBe(false);
    expect(looksLikeIdJag("garbage")).toBe(false);
  });
});

describe("orgIdJagGrant", () => {
  function tokenRequest(): Request {
    return new Request(`${APP}/api/oauth2/token`, { method: "POST" });
  }

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
