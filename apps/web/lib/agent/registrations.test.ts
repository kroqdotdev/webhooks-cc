import { afterEach, describe, expect, test, vi } from "vitest";

// serverEnv() parses lazily; dummies for the fields it requires.
process.env.NEXT_PUBLIC_APP_URL = "https://webhooks.cc";
process.env.NEXT_PUBLIC_WEBHOOK_URL ??= "https://go.webhooks.cc";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.CAPTURE_SHARED_SECRET ??= "test-capture-secret";
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role";
process.env.RECEIVER_INTERNAL_URL ??= "http://localhost:3001";

// The insert takes 1.5 s of clock time, as a slow database round trip would.
const insert = vi.fn(async () => {
  vi.setSystemTime(Date.now() + 1500);
  return { error: null };
});
const pruneQuery = {
  select: () => pruneQuery,
  eq: () => pruneQuery,
  order: () => pruneQuery,
  range: async () => ({ data: [], error: null }),
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ insert, ...pruneQuery }) }),
}));

import { ACCESS_TOKEN_TTL_SECONDS } from "./constants";
import { mintAccessToken, tokenLifetimeSeconds, type RegistrationRow } from "./registrations";

afterEach(() => {
  vi.useRealTimers();
});

describe("tokenLifetimeSeconds", () => {
  test("is the full lifetime for a token issued now", () => {
    const issued = Date.parse("2026-10-29T12:00:00.000Z");
    expect(tokenLifetimeSeconds(issued, issued + 3600 * 1000)).toBe(3600);
  });

  test("never reports more than the token has", () => {
    const issued = Date.parse("2026-10-29T12:00:00.000Z");
    // A pre-claim token capped by its registration's expiry.
    expect(tokenLifetimeSeconds(issued, issued + 1234_999)).toBe(1234);
    expect(tokenLifetimeSeconds(issued, issued + 500)).toBe(1);
  });
});

describe("mintAccessToken", () => {
  test("reports the configured lifetime even when the insert takes time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-29T12:00:00.000Z"));
    const now = Date.now();

    const token = await mintAccessToken(
      {
        id: "reg-1",
        client_name: "test-agent",
        kind: "anonymous",
        claimed_at: null,
      } as RegistrationRow,
      {
        userId: null,
        scopes: ["endpoints:write"],
        issuedAtMs: now,
        expiresAtMs: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
      }
    );

    expect(insert).toHaveBeenCalledOnce();
    expect(token.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(token.accessToken).toMatch(/^whcc_/);
  });
});
