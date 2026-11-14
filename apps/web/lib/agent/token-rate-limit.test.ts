import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Which budget the token endpoint counts a request against
 * (lib/agent/token-rate-limit.ts): per issuer for an ID-JAG from an issuer
 * some team trusts, per address for everything else.
 */

const calls: { kind: "ip" | "key"; scope: string; max: number }[] = [];
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitWithInfo: async (_request: Request, scope: string, max: number) => {
    calls.push({ kind: "ip", scope, max });
    return { response: null };
  },
  checkRateLimitByKeyWithInfo: async (key: string, max: number) => {
    calls.push({ kind: "key", scope: key, max });
    return { response: null };
  },
}));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));

let trustedIssuer: string | null | Error = null;
vi.mock("./org-id-jag", () => ({
  trustedOrgIssuerOf: async () => {
    if (trustedIssuer instanceof Error) throw trustedIssuer;
    return trustedIssuer;
  },
}));

const { tokenRateLimit, issuerRateKey } = await import("./token-rate-limit");

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ISS = "https://identity.example.com/issuers/org-1";
const request = () => new Request("https://webhooks.cc/api/oauth2/token", { method: "POST" });

beforeEach(() => {
  calls.length = 0;
  trustedIssuer = null;
});

describe("tokenRateLimit", () => {
  test("counts an assertion from a trusted issuer per issuer, 600 a minute", async () => {
    trustedIssuer = ISS;
    await tokenRateLimit(request(), { grant_type: JWT_BEARER, assertion: "a.b.c" });
    expect(calls).toEqual([{ kind: "key", scope: issuerRateKey(ISS), max: 600 }]);
  });

  test("counts every other assertion per address, 60 a minute", async () => {
    await tokenRateLimit(request(), { grant_type: JWT_BEARER, assertion: "a.b.c" });
    expect(calls).toEqual([{ kind: "ip", scope: "agent-token", max: 60 }]);
  });

  test("falls back to the address when the trust lookup fails", async () => {
    trustedIssuer = new Error("database down");
    await tokenRateLimit(request(), { grant_type: JWT_BEARER, assertion: "a.b.c" });
    expect(calls).toEqual([{ kind: "ip", scope: "agent-token", max: 60 }]);
  });

  test("keeps the claim grant per address, and OAuth grants at 600 per address", async () => {
    trustedIssuer = ISS;
    await tokenRateLimit(request(), { grant_type: "urn:workos:agent-auth:grant-type:claim" });
    await tokenRateLimit(request(), { grant_type: "refresh_token" });
    await tokenRateLimit(request(), { grant_type: "authorization_code" });
    expect(calls).toEqual([
      { kind: "ip", scope: "agent-token", max: 60 },
      { kind: "ip", scope: "oauth-token", max: 600 },
      { kind: "ip", scope: "oauth-token", max: 600 },
    ]);
  });

  test("never looks the issuer up for a grant without an assertion", async () => {
    trustedIssuer = ISS;
    await tokenRateLimit(request(), { grant_type: JWT_BEARER });
    expect(calls).toEqual([{ kind: "ip", scope: "agent-token", max: 60 }]);
  });
});
