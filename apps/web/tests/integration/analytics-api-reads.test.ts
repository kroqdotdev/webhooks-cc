import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * API read counts (migration 00089): the web app's flush adds counts per
 * account, day and client, a second flush adds to them, rows for accounts
 * that no longer exist are dropped, and the daily report lists an account
 * whose only activity was reading, with its reads per client.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// A day no other suite writes to, far enough back that no account was created on it.
const DAY = "2001-02-03";
const now = new Date(`${DAY}T12:00:00Z`);
let userId: string;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  vi.stubEnv("ANALYTICS_SERVER", "true");
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-api-reads-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userId = data.user!.id;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (userId) await admin.auth.admin.deleteUser(userId);
});

describe("API read counts", () => {
  it("adds flushed counts and reports them per client for the day", async () => {
    const { countApiRead, flushApiReads } = await import("@/lib/analytics-reads");
    const read = { method: "GET", userId, via: "api_key" as const, now };
    countApiRead({ ...read, userAgent: "webhooks-cc-python/0.5.0" });
    countApiRead({ ...read, userAgent: "whk-cli/1.8.0" });
    countApiRead({ ...read, method: "POST", userAgent: "whk-cli/1.8.0" });
    countApiRead({ ...read, userId: crypto.randomUUID(), userAgent: "whk-cli/1.8.0" });
    await flushApiReads();
    countApiRead({ ...read, userAgent: "webhooks-cc-python/0.5.0" });
    await flushApiReads();

    const { data: rows, error } = await admin
      .from("analytics_api_reads")
      .select("user_id, client, reads")
      .eq("day", DAY)
      .order("client");
    expect(error).toBeNull();
    expect(rows).toEqual([
      { user_id: userId, client: "cli", reads: 1 },
      { user_id: userId, client: "python_sdk", reads: 2 },
    ]);

    const { data: report, error: reportError } = await admin.rpc("analytics_daily_accounts", {
      p_day: DAY,
    });
    expect(reportError).toBeNull();
    const mine = (
      report as { user_id: string; api_reads: number; api_reads_by_client: object }[]
    ).filter((row) => row.user_id === userId);
    expect(mine).toHaveLength(1);
    expect(Number(mine[0].api_reads)).toBe(3);
    expect(mine[0].api_reads_by_client).toEqual({ cli: 1, python_sdk: 2 });
  });
});
