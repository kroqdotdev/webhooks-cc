import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { billingAnalyticsEvent } = await import("./analytics-billing");

describe("billingAnalyticsEvent", () => {
  beforeEach(() => {
    vi.stubEnv("POLAR_PRO_PRODUCT_ID", "prod-pro");
    vi.stubEnv("POLAR_BUSINESS_ANNUAL_PRODUCT_ID", "prod-biz-year");
  });

  it("reports a paid order as revenue before tax, in the major unit", () => {
    expect(
      billingAnalyticsEvent("order.paid", null, {
        product_id: "prod-pro",
        net_amount: 800,
        total_amount: 1000,
        currency: "usd",
        billing_reason: "subscription_cycle",
      })
    ).toEqual({
      event: "order_paid",
      properties: {
        revenue: 8,
        currency: "USD",
        billing_reason: "subscription_cycle",
        product: "pro_month",
        account_kind: "user",
      },
    });
  });

  it("names subscription changes and the plan they are for", () => {
    expect(
      billingAnalyticsEvent("subscription.canceled", null, { product: { id: "prod-biz-year" } })
    ).toEqual({
      event: "subscription_canceled",
      properties: { product: "business_year", account_kind: "user" },
    });
    expect(billingAnalyticsEvent("subscription.revoked", "team-1", {})?.properties).toEqual({
      product: "team_seats",
      account_kind: "team",
    });
  });

  it("ignores events that are not purchases or lifecycle changes", () => {
    expect(billingAnalyticsEvent("subscription.updated", null, {})).toBeNull();
    expect(billingAnalyticsEvent("customer.updated", null, {})).toBeNull();
    expect(billingAnalyticsEvent("order.paid", null, { currency: "usd" })).toBeNull();
  });
});
