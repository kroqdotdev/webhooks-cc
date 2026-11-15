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
// It answers whether a row went in: insert_agent_access_token() inserts only
// while the registration is live (migration 00105).
let inserts = true;
const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>(async () => {
  vi.setSystemTime(Date.now() + 1500);
  return { data: inserts, error: null };
});
const pruneQuery = {
  select: () => pruneQuery,
  eq: () => pruneQuery,
  order: () => pruneQuery,
  range: async () => ({ data: [], error: null }),
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc, from: () => pruneQuery }),
}));

import { ACCESS_TOKEN_TTL_SECONDS } from "./constants";
import {
  InvalidGrantError,
  mintAccessToken,
  tokenLifetimeSeconds,
  type RegistrationRow,
} from "./registrations";

afterEach(() => {
  vi.useRealTimers();
  inserts = true;
  rpc.mockClear();
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
    expect(tokenLifetimeSeconds(issued, issued + 500)).toBe(0);
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

    expect(rpc).toHaveBeenCalledOnce();
    expect(token.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(token.accessToken).toMatch(/^whcc_/);
  });

  test("inserts through the conditional SQL function, never the table", async () => {
    const now = Date.now();
    await mintAccessToken(
      { id: "reg-2", client_name: null, kind: "identity_assertion" } as RegistrationRow,
      { userId: "user-1", scopes: ["endpoints:read"], issuedAtMs: now, expiresAtMs: now + 1000 }
    );
    expect(rpc).toHaveBeenCalledWith(
      "insert_agent_access_token",
      expect.objectContaining({
        p_registration_id: "reg-2",
        p_user_id: "user-1",
        p_name: "Agent token (identity_assertion)",
        p_scopes: ["endpoints:read"],
      })
    );
    // Only the hash goes to the database.
    const args = rpc.mock.calls[0][1];
    expect(args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses when the registration was revoked since it was read", async () => {
    inserts = false;
    const now = Date.now();
    await expect(
      mintAccessToken({ id: "reg-3", client_name: null, kind: "oauth" } as RegistrationRow, {
        userId: "user-1",
        scopes: [],
        issuedAtMs: now,
        expiresAtMs: now + 1000,
      })
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });
});
