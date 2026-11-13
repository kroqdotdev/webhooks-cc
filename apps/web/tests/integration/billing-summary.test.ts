import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { getBillingSummary } from "@/lib/billing/summary";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let userId: string;

describe("getBillingSummary", () => {
  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `test-billing-summary-${Date.now()}@webhooks-test.local`,
      password: "TestPassword123!",
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user!.id;
  });

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("reads a Free account: no subscription, add-ons for every resource, no teams", async () => {
    const summary = await getBillingSummary(userId);
    expect(summary).toMatchObject({ plan: "free", subscription: null, teams: [] });
    expect(Object.keys(summary!.addons).sort()).toEqual(["domains", "pages", "requests"]);
    expect(summary!.addons.requests.eligible).toBe(false);
  });

  it("reads a paid plan's subscription and a change waiting for the renewal", async () => {
    const renews = new Date(Date.now() + 20 * 86_400_000).toISOString();
    await admin
      .from("users")
      .update({
        plan: "pro",
        subscription_status: "active",
        billing_interval: "month",
        billing_period_end: renews,
        cancel_at_period_end: false,
        pending_plan: "business",
        pending_interval: "year",
      })
      .eq("id", userId);
    const summary = await getBillingSummary(userId);
    expect(summary).toMatchObject({
      plan: "pro",
      subscription: {
        status: "active",
        interval: "month",
        renewsAt: renews,
        cancelAtPeriodEnd: false,
        pendingChange: { plan: "business", interval: "year" },
      },
    });
  });

  it("answers null for an unknown account", async () => {
    expect(await getBillingSummary("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
