import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Which budget the token endpoint counts a request against before anything
 * is verified (lib/agent/token-rate-limit.ts): an assertion naming an issuer
 * under a configured prefix per address and per (issuer, address), never in
 * a bucket other addresses share; everything else per address.
 */

const calls: { scope: string; max: number; ip: string }[] = [];
const exhausted = new Set<string>();
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitWithInfo: async (request: Request, scope: string, max: number) => {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    calls.push({ scope, max, ip });
    return exhausted.has(`${scope}@${ip}`)
      ? { response: new Response(null, { status: 429 }) }
      : { response: null };
  },
}));

let candidate: string | null = null;
vi.mock("./org-id-jag", () => ({
  orgIssuerCandidate: () => candidate,
}));

const { tokenRateLimit, issuerAddressScope, issuerRateKey } = await import("./token-rate-limit");

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ISS = "https://identity.example.com/issuers/org-1";
const request = (ip = "198.51.100.7") =>
  new Request("https://webhooks.cc/api/oauth2/token", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
  });

beforeEach(() => {
  calls.length = 0;
  exhausted.clear();
  candidate = null;
});

describe("tokenRateLimit", () => {
  test("counts an organisation assertion per address and per issuer and address", async () => {
    candidate = ISS;
    await tokenRateLimit(request(), { grant_type: JWT_BEARER, assertion: "a.b.c" });
    expect(calls).toEqual([
      { scope: "agent-token-org", max: 1200, ip: "198.51.100.7" },
      { scope: issuerAddressScope(ISS), max: 600, ip: "198.51.100.7" },
    ]);
    // The issuer's raw URL never goes into a key.
    expect(issuerAddressScope(ISS)).not.toContain("identity.example.com");
  });

  test("one address spending its budget for an issuer leaves other addresses alone", async () => {
    candidate = ISS;
    exhausted.add(`${issuerAddressScope(ISS)}@203.0.113.9`);
    const flooded = await tokenRateLimit(request("203.0.113.9"), {
      grant_type: JWT_BEARER,
      assertion: "a.b.c",
    });
    expect(flooded.response?.status).toBe(429);
    const other = await tokenRateLimit(request("198.51.100.7"), {
      grant_type: JWT_BEARER,
      assertion: "a.b.c",
    });
    expect(other.response).toBeNull();
    // Nothing before the signature touches the issuer's shared bucket.
    expect(calls.some((call) => call.scope === issuerRateKey(ISS))).toBe(false);
  });

  test("stops at the per-address budget before the issuer's", async () => {
    candidate = ISS;
    exhausted.add("agent-token-org@198.51.100.7");
    const res = await tokenRateLimit(request(), { grant_type: JWT_BEARER, assertion: "a.b.c" });
    expect(res.response?.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  test("counts every other assertion per address, 60 a minute", async () => {
    await tokenRateLimit(request(), { grant_type: JWT_BEARER, assertion: "a.b.c" });
    expect(calls).toEqual([{ scope: "agent-token", max: 60, ip: "198.51.100.7" }]);
  });

  test("keeps the claim grant per address, and OAuth grants at 600 per address", async () => {
    candidate = ISS;
    await tokenRateLimit(request(), { grant_type: "urn:workos:agent-auth:grant-type:claim" });
    await tokenRateLimit(request(), { grant_type: "refresh_token" });
    await tokenRateLimit(request(), { grant_type: "authorization_code" });
    expect(calls.map(({ scope, max }) => ({ scope, max }))).toEqual([
      { scope: "agent-token", max: 60 },
      { scope: "oauth-token", max: 600 },
      { scope: "oauth-token", max: 600 },
    ]);
  });

  test("never reads an issuer for a grant without an assertion", async () => {
    candidate = ISS;
    await tokenRateLimit(request(), { grant_type: JWT_BEARER });
    expect(calls.map((call) => call.scope)).toEqual(["agent-token"]);
  });
});
