import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { processBillingPeriodResets } from "@/lib/supabase/billing";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://192.168.0.247:8000";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TEST_PASSWORD = "TestPassword123!";

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let canceledUserId = "";
let activeUserId = "";
let freeUserId = "";
let canceledUserExpiredAt = "";
let activeUserExpiredAt = "";
let freeUserExpiredAt = "";

async function createTestUser(emailPrefix: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@webhooks-test.local`,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: {
      full_name: emailPrefix,
    },
  });

  if (error) {
    throw error;
  }

  return data.user!.id;
}

describe("Supabase Billing Period Reset Integration", () => {
  beforeAll(async () => {
    canceledUserId = await createTestUser("billing-reset-canceled");
    activeUserId = await createTestUser("billing-reset-active");
    freeUserId = await createTestUser("billing-reset-free");

    canceledUserExpiredAt = new Date(Date.now() - 2 * 60_000).toISOString();
    activeUserExpiredAt = new Date(Date.now() - 90_000).toISOString();
    freeUserExpiredAt = new Date(Date.now() - 60_000).toISOString();

    const { error: canceledUpdateError } = await admin
      .from("users")
      .update({
        plan: "pro",
        request_limit: 100_000,
        requests_used: 42,
        period_start: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        period_end: canceledUserExpiredAt,
        cancel_at_period_end: true,
        subscription_status: "canceled",
        polar_customer_id: `polar_cust_${Date.now()}_cancel`,
        polar_subscription_id: `polar_sub_${Date.now()}_cancel`,
      })
      .eq("id", canceledUserId);

    expect(canceledUpdateError).toBeNull();

    const { error: activeUpdateError } = await admin
      .from("users")
      .update({
        plan: "pro",
        request_limit: 100_000,
        requests_used: 91,
        period_start: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        period_end: activeUserExpiredAt,
        cancel_at_period_end: false,
        subscription_status: "active",
        polar_customer_id: `polar_cust_${Date.now()}_active`,
        polar_subscription_id: `polar_sub_${Date.now()}_active`,
      })
      .eq("id", activeUserId);

    expect(activeUpdateError).toBeNull();

    const { error: freeUpdateError } = await admin
      .from("users")
      .update({
        plan: "free",
        request_limit: 50,
        requests_used: 50,
        period_start: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        period_end: freeUserExpiredAt,
        cancel_at_period_end: false,
      })
      .eq("id", freeUserId);

    expect(freeUpdateError).toBeNull();
  });

  afterAll(async () => {
    if (canceledUserId) {
      await admin.auth.admin.deleteUser(canceledUserId);
    }
    if (activeUserId) {
      await admin.auth.admin.deleteUser(activeUserId);
    }
    if (freeUserId) {
      await admin.auth.admin.deleteUser(freeUserId);
    }
  });

  it("downgrades canceled pro users and renews active pro users while skipping free users", async () => {
    const result = await processBillingPeriodResets();

    expect(result.processed).toBeGreaterThanOrEqual(2);
    expect(result.downgraded).toBeGreaterThanOrEqual(1);
    expect(result.renewed).toBeGreaterThanOrEqual(1);

    const { data: canceledUser, error: canceledUserError } = await admin
      .from("users")
      .select(
        "plan, request_limit, requests_used, subscription_status, cancel_at_period_end, period_start, period_end, polar_subscription_id"
      )
      .eq("id", canceledUserId)
      .single();

    expect(canceledUserError).toBeNull();
    expect(canceledUser).toEqual({
      plan: "free",
      request_limit: 50,
      requests_used: 0,
      subscription_status: null,
      cancel_at_period_end: false,
      period_start: null,
      period_end: null,
      polar_subscription_id: null,
    });

    const { data: activeUser, error: activeUserError } = await admin
      .from("users")
      .select(
        "plan, request_limit, requests_used, subscription_status, cancel_at_period_end, period_start, period_end, polar_subscription_id"
      )
      .eq("id", activeUserId)
      .single();

    expect(activeUserError).toBeNull();
    expect(activeUser?.plan).toBe("pro");
    expect(activeUser?.request_limit).toBe(100_000);
    expect(activeUser?.requests_used).toBe(0);
    expect(activeUser?.subscription_status).toBe("active");
    expect(activeUser?.cancel_at_period_end).toBe(false);
    expect(Date.parse(activeUser!.period_start!)).toBe(Date.parse(activeUserExpiredAt));
    expect(activeUser?.polar_subscription_id).toBeTruthy();
    expect(activeUser?.period_end).toBeTruthy();

    const renewedPeriodEnd = Date.parse(activeUser!.period_end!);
    const previousPeriodEnd = Date.parse(activeUserExpiredAt);
    const delta = renewedPeriodEnd - previousPeriodEnd;
    expect(delta).toBeGreaterThanOrEqual(29 * 24 * 60 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);

    const { data: freeUser, error: freeUserError } = await admin
      .from("users")
      .select("plan, request_limit, requests_used, period_end")
      .eq("id", freeUserId)
      .single();

    expect(freeUserError).toBeNull();
    expect(freeUser?.plan).toBe("free");
    expect(freeUser?.request_limit).toBe(50);
    expect(freeUser?.requests_used).toBe(50);
    expect(Date.parse(freeUser!.period_end!)).toBe(Date.parse(freeUserExpiredAt));
  });
});
