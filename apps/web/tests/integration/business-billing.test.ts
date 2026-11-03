import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * Business billing (migration 00070) against the local database: the plan
 * webhook for Business and its annual interval, page add-ons that count only
 * with Business, Team Business as the team's own seat plan (migration 00083)
 * and its per-seat allowance, page overage
 * reporting and the order pages are charged in, and extra inbound domains
 * (migration 00073). Polar is mocked; the
 * webhook's product matching reads the product ids set here.
 */

const polarMocks = vi.hoisted(() => ({
  createPolarClient: vi.fn(() => ({
    subscriptions: { update: vi.fn(), get: vi.fn(), revoke: vi.fn() },
  })),
  validateEvent: vi.fn(),
}));

vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  return {
    ...actual,
    createPolarClient: polarMocks.createPolarClient,
    getPolarWebhookSecret: () => "whsec_test",
    loggablePolarError: (error: unknown) => error,
  };
});

vi.mock("@polar-sh/sdk/2026-10", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polar-sh/sdk/2026-10")>();
  return { ...actual, webhooks: { ...actual.webhooks, validateEvent: polarMocks.validateEvent } };
});

import { POST as polarWebhookRoute } from "@/app/api/polar-webhook/route";
import { DELETE as keepPlanRoute } from "@/app/api/billing/change-plan/route";
import { addMonthsUtc, annualQuotaWindow } from "@/lib/supabase/billing";
import {
  applyCapacityWebhookEvent,
  changeMonthlyBlocks,
  getCapacityState,
  reconcileAddonsWithPlan,
  setOverage,
} from "@/lib/supabase/capacity-billing";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
let counter = 0;
const userIds: string[] = [];
const teamIds: string[] = [];
const DAY = 86_400_000;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries({
    POLAR_PRO_PRODUCT_ID: "prod_pro_test",
    POLAR_BUSINESS_PRODUCT_ID: "prod_business_test",
    POLAR_BUSINESS_ANNUAL_PRODUCT_ID: "prod_business_year_test",
    POLAR_TEAMS_PRODUCT_ID: "prod_teams_test",
    POLAR_TEAM_BUSINESS_MONTHLY_PRODUCT_ID: "prod_team_business_test",
    POLAR_TEAM_BUSINESS_ANNUAL_PRODUCT_ID: "prod_team_business_year_test",
    POLAR_DOMAINS_PRODUCT_ID: "prod_domains_test",
    POLAR_PAGE_BLOCKS_PRODUCT_ID: "prod_page_blocks_test",
    POLAR_MONTHLY_PAGE_BLOCKS_PRODUCT_ID: "prod_monthly_page_blocks_test",
    POLAR_MONTHLY_PAGE_BLOCKS_ADD_PRODUCT_ID: "prod_monthly_page_blocks_add_test",
    POLAR_PAGE_OVERAGE_PRODUCT_ID: "prod_page_overage_test",
    POLAR_DOMAINS_ADD_PRODUCT_ID: "prod_domains_add_test",
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function createUser(fields: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-business-${counter}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const id = data.user!.id;
  userIds.push(id);
  if (Object.keys(fields).length > 0) {
    const { error: updateError } = await admin.from("users").update(fields).eq("id", id);
    if (updateError) throw updateError;
  }
  return id;
}

async function user(id: string) {
  const { data, error } = await admin.from("users").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function deliver(type: string, data: Record<string, unknown>) {
  polarMocks.validateEvent.mockResolvedValueOnce({ type, data });
  const response = await polarWebhookRoute(
    new Request("https://webhooks.cc/api/polar-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": `evt_${Math.random()}`,
        "webhook-signature": "sig",
        "webhook-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: "{}",
    })
  );
  expect(response.status).toBe(200);
}

/** A team with no subscription yet, owned by a new user. */
async function createTeam(name: string): Promise<{ owner: string; teamId: string }> {
  const owner = await createUser();
  const { data, error } = await admin
    .from("teams")
    .insert({ name: `${name}-${ts}`, created_by: owner, seats: 0 })
    .select("id")
    .single();
  if (error) throw error;
  teamIds.push(data.id);
  return { owner, teamId: data.id };
}

/** The team's subscription as a Polar webhook payload. */
function teamSubscription(
  teamId: string,
  subscriptionId: string,
  product: string,
  fields: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: subscriptionId,
    customer_id: `cus_${subscriptionId}`,
    customer: { metadata: { teamId } },
    product_id: product,
    status: "active",
    seats: 2,
    cancel_at_period_end: false,
    current_period_start: new Date(Date.now() - DAY).toISOString(),
    current_period_end: new Date(Date.now() + 29 * DAY).toISOString(),
    pending_update: null,
    ...fields,
  };
}

async function teamRow(teamId: string) {
  const { data, error } = await admin.from("teams").select("*").eq("id", teamId).single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

async function pageAllowance(teamId: string): Promise<number> {
  const { data, error } = await admin.rpc("parsed_pages_balance", {
    p_user_id: null,
    p_team_id: teamId,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data).allowance as number;
}

async function teamEntitlementsRow(teamId: string) {
  const { data, error } = await admin.rpc("account_entitlements", {
    p_user_id: null,
    p_team_id: teamId,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}

/** Subscribes a team on a plan product through the webhook. */
async function subscribeTeam(
  teamId: string,
  subscriptionId: string,
  product = "prod_team_business_test",
  fields: Record<string, unknown> = {}
) {
  await deliver("subscription.created", teamSubscription(teamId, subscriptionId, product, fields));
}

async function applyAddon(
  account: { userId?: string; teamId?: string },
  kind: string,
  subscriptionId: string,
  status: string | null,
  units = 0
) {
  const { data, error } = await admin.rpc("apply_capacity_subscription", {
    p_user_id: account.userId ?? null,
    p_team_id: account.teamId ?? null,
    p_kind: kind,
    p_subscription_id: subscriptionId,
    p_status: status,
    p_units: units,
    p_pending_units: units,
    p_cancel_at_period_end: false,
    p_period_start: new Date(Date.now() - DAY).toISOString(),
    p_period_end: new Date(Date.now() + 29 * DAY).toISOString(),
  });
  if (error) throw error;
  return data as { status: string };
}

describe("the Business plan webhook", () => {
  it("sets an annual plan with a monthly quota period, and resets it only when the year turns", async () => {
    const userId = await createUser();
    const start = new Date(Date.now() - 1000);
    // Polar's year: the same day a year on.
    const yearEnd = new Date(addMonthsUtc(start.toISOString(), 12));
    const subscription = {
      id: `sub_year_${ts}`,
      customer_id: `cus_year_${ts}`,
      customer: { metadata: { userId } },
      product_id: "prod_business_year_test",
      status: "active",
      current_period_start: start.toISOString(),
      current_period_end: yearEnd.toISOString(),
      cancel_at_period_end: false,
    };
    await deliver("subscription.created", subscription);
    let row = await user(userId);
    expect(row).toMatchObject({
      plan: "business",
      request_limit: 250_000,
      billing_interval: "year",
      subscription_status: "active",
    });
    expect(Date.parse(row.billing_period_end as string)).toBe(yearEnd.getTime());
    // The first window ends 11 months before the year does, as the reset
    // job counts (Oct 31 gives Nov 30), so the test holds on any day it runs.
    expect(Date.parse(row.period_end as string)).toBe(
      Date.parse(addMonthsUtc(yearEnd.toISOString(), -11))
    );

    // A month on, the reset job rolled the quota period; a mid-year update
    // from Polar leaves it and the usage alone.
    const rolledStart = row.period_end as string;
    await admin
      .from("users")
      .update({ period_start: rolledStart, requests_used: 42 })
      .eq("id", userId);
    await deliver("subscription.updated", subscription);
    row = await user(userId);
    expect(row.period_start).toBe(rolledStart);
    expect(row.requests_used).toBe(42);

    // The next year: a new quota period from Polar's start, usage cleared.
    const nextStart = yearEnd;
    await deliver("subscription.updated", {
      ...subscription,
      current_period_start: nextStart.toISOString(),
      current_period_end: new Date(nextStart.getTime() + 365 * DAY).toISOString(),
    });
    row = await user(userId);
    expect(Date.parse(row.period_start as string)).toBe(nextStart.getTime());
    expect(row.requests_used).toBe(0);
  });

  it("keeps the quota period the reset job moved on when a renewal arrives a month late", async () => {
    const userId = await createUser();
    const start = new Date(Date.now() - 1000);
    const yearEnd = new Date(start.getTime() + 365 * DAY);
    const subscription = {
      id: `sub_late_${ts}`,
      customer_id: `cus_late_${ts}`,
      customer: { metadata: { userId } },
      product_id: "prod_business_year_test",
      status: "active",
      current_period_start: start.toISOString(),
      current_period_end: yearEnd.toISOString(),
      cancel_at_period_end: false,
    };
    await deliver("subscription.created", subscription);
    // The year turned and the reset job already moved the quota period into
    // the new year's second month before Polar's renewal was applied.
    const movedStart = new Date(yearEnd);
    movedStart.setUTCMonth(movedStart.getUTCMonth() + 1);
    const movedEnd = new Date(movedStart);
    movedEnd.setUTCMonth(movedEnd.getUTCMonth() + 1);
    await admin
      .from("users")
      .update({ period_start: movedStart.toISOString(), period_end: movedEnd.toISOString() })
      .eq("id", userId);
    await deliver("subscription.updated", {
      ...subscription,
      current_period_start: yearEnd.toISOString(),
      current_period_end: new Date(yearEnd.getTime() + 365 * DAY).toISOString(),
    });
    const row = await user(userId);
    expect(Date.parse(row.period_start as string)).toBe(movedStart.getTime());
    expect(Date.parse(row.period_end as string)).toBe(movedEnd.getTime());
  });

  it("counts annual quota windows in SQL as the web app does", async () => {
    const cases: Array<[string, string, string]> = [
      ["2028-01-31T10:00:00.000Z", "2027-01-31T10:00:00.000Z", "2027-01-31T10:00:00.000Z"],
      ["2028-01-31T10:00:00.000Z", "2027-02-28T10:00:00.000Z", "2027-02-28T10:00:00.000Z"],
      ["2028-01-31T10:00:00.000Z", "2027-03-31T10:00:00.000Z", "2027-06-10T00:00:00.000Z"],
      ["2028-01-31T10:00:00.000Z", "2027-03-31T10:00:00.000Z", "2027-04-30T09:59:59.000Z"],
      ["2028-01-31T10:00:00.000Z", "2027-11-28T10:00:00.000Z", "2027-11-28T10:01:00.000Z"],
      ["2028-01-31T10:00:00.000Z", "2028-01-31T10:00:00.000Z", "2028-03-01T00:00:00.000Z"],
      ["2029-02-28T00:00:00.000Z", "2028-02-29T00:00:00.000Z", "2028-02-29T00:00:00.000Z"],
      ["2027-08-15T23:30:00.000Z", "2026-12-15T23:30:00.000Z", "2026-12-20T00:00:00.000Z"],
    ];
    for (const [anchor, from, at] of cases) {
      const { data, error } = await admin.rpc("annual_quota_window", {
        p_anchor: anchor,
        p_from: from,
        p_at: at,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as {
        window_start: string;
        window_end: string;
      };
      const expected = annualQuotaWindow(anchor, from, at);
      expect([Date.parse(row.window_start), Date.parse(row.window_end)]).toEqual([
        Date.parse(expected.start),
        Date.parse(expected.end),
      ]);
    }
  });

  it("puts a drifted annual window back on the year's day without a few-day allowance", async () => {
    // The last window ended just now, two days before the year's boundary.
    const oldEnd = new Date(Date.now() - 60 * 60_000).toISOString();
    const yearEnd = addMonthsUtc(new Date(Date.now() + 2 * DAY).toISOString(), 11);
    const fields = {
      requests_used: 1234,
      billing_interval: "year",
      period_start: new Date(Date.parse(oldEnd) - 28 * DAY).toISOString(),
      period_end: oldEnd,
      billing_period_end: yearEnd,
    };
    const userId = await createUser({
      ...fields,
      plan: "business",
      request_limit: 250_000,
      subscription_status: "active",
    });
    const { teamId } = await createTeam("biz-drift");
    const { error: teamError } = await admin
      .from("teams")
      .update({ ...fields, subscription_status: "active", business: true, seats: 2 })
      .eq("id", teamId);
    if (teamError) throw teamError;

    const { error } = await admin.rpc("process_billing_period_resets");
    if (error) throw error;

    const expected = annualQuotaWindow(yearEnd, oldEnd, new Date().toISOString());
    for (const row of [await user(userId), await teamRow(teamId)]) {
      expect(row.requests_used).toBe(0);
      const start = Date.parse(String(row.period_start));
      const end = Date.parse(String(row.period_end));
      expect(start).toBe(Date.parse(oldEnd));
      expect(end).toBe(Date.parse(expected.end));
      expect(end - start).toBeGreaterThanOrEqual(7 * DAY);
      // On a boundary counted from the year's end.
      const boundaries = Array.from({ length: 13 }, (_, k) =>
        Date.parse(addMonthsUtc(yearEnd, -k))
      );
      expect(boundaries).toContain(end);
    }
  });

  it("keeps the plan through the route: Polar's pending update is cleared", async () => {
    const userId = await createUser({
      plan: "business",
      subscription_status: "active",
      polar_subscription_id: `sub_keep_${ts}`,
      pending_plan: "pro",
      pending_interval: "month",
    });
    const update = vi.fn().mockResolvedValue({});
    polarMocks.createPolarClient.mockReturnValueOnce({
      subscriptions: { update, get: vi.fn(), revoke: vi.fn() },
    });
    const { data: created } = await admin.auth.admin.getUserById(userId);
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: session, error } = await client.auth.signInWithPassword({
      email: created.user!.email!,
      password: "TestPassword123!",
    });
    if (error) throw error;
    const response = await keepPlanRoute(
      new Request("https://webhooks.cc/api/billing/change-plan", {
        method: "DELETE",
        headers: { authorization: `Bearer ${session.session!.access_token}` },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith(`sub_keep_${ts}`, { pending_update: null });
    expect(await user(userId)).toMatchObject({ pending_plan: null, pending_interval: null });
  });

  it("moves Pro to Business mid-period pro rata, and gives the full allowance when the period moves on", async () => {
    const userId = await createUser();
    // Two thirds of a 30-day period are left.
    const start = new Date(Date.now() - 10 * DAY);
    const end = new Date(start.getTime() + 30 * DAY);
    const base = {
      id: `sub_up_${ts}`,
      customer_id: `cus_up_${ts}`,
      customer: { metadata: { userId } },
      status: "active",
      cancel_at_period_end: false,
      current_period_start: start.toISOString(),
      current_period_end: end.toISOString(),
    };
    await deliver("subscription.created", { ...base, product_id: "prod_pro_test" });
    await admin.from("users").update({ requests_used: 90_000 }).eq("id", userId);
    expect(await user(userId)).toMatchObject({ plan: "pro", request_limit: 100_000 });

    // Polar's "invoice" change keeps the period and charges the rest of it.
    await deliver("subscription.updated", { ...base, product_id: "prod_business_test" });
    let row = await user(userId);
    expect(row).toMatchObject({
      plan: "business",
      billing_interval: "month",
      requests_used: 90_000,
    });
    expect(row.request_limit as number).toBeGreaterThanOrEqual(199_000);
    expect(row.request_limit as number).toBeLessThanOrEqual(200_000);
    expect(row.prorated_pages as number).toBeGreaterThanOrEqual(1_360);
    expect(row.prorated_pages as number).toBeLessThanOrEqual(1_367);
    const { data: balance } = await admin.rpc("parsed_pages_balance", {
      p_user_id: userId,
      p_team_id: null,
    });
    expect((balance as Array<{ allowance: number }>)[0].allowance).toBe(row.prorated_pages);

    // A repeat of the event keeps it.
    const limit = row.request_limit;
    await deliver("subscription.updated", { ...base, product_id: "prod_business_test" });
    expect((await user(userId)).request_limit).toBe(limit);

    // The fallback renewal (the webhook is late) moves the period on, and
    // the trigger gives Business's own allowance back with it.
    await admin
      .from("users")
      .update({ period_end: new Date(Date.now() - 1000).toISOString() })
      .eq("id", userId);
    await admin.rpc("process_billing_period_resets");
    row = await user(userId);
    expect(row).toMatchObject({
      plan: "business",
      request_limit: 250_000,
      requests_used: 0,
      prorated_pages: null,
      prorated_window: null,
    });
  });

  it("records a change Polar holds for the renewal, and clears it when the plan lapses", async () => {
    const userId = await createUser();
    const start = new Date(Date.now() - 5 * DAY);
    const base = {
      id: `sub_down_${ts}`,
      customer_id: `cus_down_${ts}`,
      customer: { metadata: { userId } },
      status: "active",
      cancel_at_period_end: false,
      current_period_start: start.toISOString(),
      current_period_end: new Date(start.getTime() + 30 * DAY).toISOString(),
      product_id: "prod_business_test",
    };
    await deliver("subscription.created", base);
    await deliver("subscription.updated", {
      ...base,
      pending_update: { product_id: "prod_pro_test", seats: null, units: null },
    });
    expect(await user(userId)).toMatchObject({
      plan: "business",
      request_limit: 250_000,
      pending_plan: "pro",
      pending_interval: "month",
    });

    await deliver("subscription.revoked", { ...base, status: "canceled" });
    expect(await user(userId)).toMatchObject({ plan: "free", pending_plan: null });
  });
});

describe("parsed-page add-ons", () => {
  it("count only on Business, and one-time page blocks are granted and refunded", async () => {
    const business = await createUser({ plan: "business", subscription_status: "active" });
    expect(
      (await applyAddon({ userId: business }, "page_blocks", `sub_pb_${ts}`, "active", 2)).status
    ).toBe("ok");
    await applyAddon({ userId: business }, "page_overage", `sub_po_${ts}`, "active");
    let row = await user(business);
    expect(row.page_block_pages).toBe(2000);
    expect(row.page_overage_active).toBe(true);

    // Down to Pro: the add-ons stop counting.
    await admin.from("users").update({ plan: "pro" }).eq("id", business);
    await admin.rpc("sync_capacity_account", { p_user_id: business, p_team_id: null });
    row = await user(business);
    expect(row.page_block_pages).toBe(0);
    expect(row.page_overage_active).toBe(false);

    const { error } = await admin.rpc("grant_capacity_purchase", {
      p_order_id: `ord_pages_${ts}`,
      p_user_id: business,
      p_team_id: null,
      p_kind: "page_credits",
      p_units: 3,
      p_amount: 2400,
    });
    if (error) throw error;
    expect((await user(business)).credit_pages).toBe(3000);
    const { data: refund } = await admin.rpc("refund_capacity_purchase", {
      p_order_id: `ord_pages_${ts}`,
    });
    expect(refund).toMatchObject({ status: "ok", kind: "page_credits" });
    expect((await user(business)).credit_pages).toBe(0);
  });

  it("charges the allowance and monthly blocks, then credits, then overage", async () => {
    const userId = await createUser({
      plan: "business",
      subscription_status: "active",
      period_start: new Date(Date.now() - DAY).toISOString(),
      period_end: new Date(Date.now() + 29 * DAY).toISOString(),
    });
    await applyAddon({ userId }, "page_blocks", `sub_pb2_${ts}`, "active", 1);
    await applyAddon({ userId }, "page_overage", `sub_po2_${ts}`, "active");
    await admin
      .from("users")
      .update({ credit_pages: 500, page_overage_max: 1000 })
      .eq("id", userId);

    const take = async (pages: number) => {
      const { data, error } = await admin.rpc("take_parsed_pages", {
        p_user_id: userId,
        p_team_id: null,
        p_pages: pages,
      });
      if (error) throw error;
      return data as Record<string, unknown>;
    };
    // 2,000 included + 1,000 from a monthly block.
    expect(await take(3200)).toMatchObject({ granted: true, allowance: 3000, credits: 200 });
    expect(await take(400)).toMatchObject({ granted: true, credits: 300, overage: 100 });
    // Past the overage maximum: refused whole.
    expect(await take(1000)).toMatchObject({ granted: false });
    const row = await user(userId);
    expect(row.page_overage_total).toBe(100);
  });

  it("reports page overage to its own meter range", async () => {
    const userId = await createUser({
      plan: "business",
      polar_customer_id: `cus_pages_${ts}`,
      page_overage_total: 30,
      page_overage_reported: 0,
    });
    const { data, error } = await admin.rpc("claim_page_overage_reports", {
      p_limit: 50,
      p_lease_seconds: 120,
    });
    if (error) throw error;
    const mine = (data as { account_id: string; from_total: number; to_total: number }[]).find(
      (row) => row.account_id === userId
    );
    expect(mine).toMatchObject({ from_total: 0, to_total: 30 });
    await admin.rpc("complete_page_overage_report", {
      p_account_kind: "user",
      p_account_id: userId,
      p_to_total: 30,
    });
    expect((await user(userId)).page_overage_reported).toBe(30);
  });
});

describe("Team Business", () => {
  it("is the team's plan: Business per seat, and its retention kept a week after it ends", async () => {
    const { teamId } = await createTeam("biz");
    const sub = `sub_tb_${ts}`;
    await subscribeTeam(teamId, sub);
    let row = await teamRow(teamId);
    expect(row).toMatchObject({
      business: true,
      seats: 2,
      request_limit: 500_000,
      billing_interval: "month",
      subscription_status: "active",
    });
    expect(await pageAllowance(teamId)).toBe(4_000);
    expect(await teamEntitlementsRow(teamId)).toMatchObject({
      key: "team_business",
      parsed_pages: 4_000,
      ai_assists: 500,
      layouts_per_endpoint: 50,
      custom_domains: 1,
    });

    // A seat change scales everything per seat.
    await admin.rpc("update_team_seats", { p_team_id: teamId, p_seats: 3 });
    expect((await teamRow(teamId)).request_limit).toBe(750_000);
    expect(await pageAllowance(teamId)).toBe(6_000);

    // Moved to Teams at the renewal: Teams' limits, and the longer retention for a week.
    await deliver(
      "subscription.updated",
      teamSubscription(teamId, sub, "prod_teams_test", {
        seats: 3,
        current_period_start: new Date(Date.now() + 29 * DAY).toISOString(),
        current_period_end: new Date(Date.now() + 59 * DAY).toISOString(),
      })
    );
    row = await teamRow(teamId);
    expect(row).toMatchObject({
      business: false,
      request_limit: 300_000,
      retention_floor_days: 90,
      billing_interval: "month",
    });
    expect(await pageAllowance(teamId)).toBe(100);
    expect((await teamEntitlementsRow(teamId)).ai_assists).toBe(20);
  });

  it("grants an upgrade within the period pro rata, and the full allowance from the next", async () => {
    const { teamId } = await createTeam("biz-prorate");
    const sub = `sub_tb_pr_${ts}`;
    const start = new Date(Date.now() - 15 * DAY).toISOString();
    const end = new Date(Date.now() + 15 * DAY).toISOString();
    await subscribeTeam(teamId, sub, "prod_teams_test", {
      current_period_start: start,
      current_period_end: end,
    });
    expect((await teamRow(teamId)).request_limit).toBe(200_000);

    await deliver(
      "subscription.updated",
      teamSubscription(teamId, sub, "prod_team_business_test", {
        current_period_start: start,
        current_period_end: end,
      })
    );
    let row = await teamRow(teamId);
    expect(row.business).toBe(true);
    expect(row.prorated_window).not.toBeNull();
    // Half the period left: 100k + half of the extra 150k per seat.
    expect(Number(row.request_limit)).toBeGreaterThan(345_000);
    expect(Number(row.request_limit)).toBeLessThan(355_000);
    // Pages: Teams' 100 for the team, plus half the way to 2,000 a seat.
    const pages = await pageAllowance(teamId);
    expect(pages).toBeGreaterThan(2_000);
    expect(pages).toBeLessThan(2_100);

    // A repeated event in the same window keeps the pro rata figure.
    await deliver(
      "subscription.updated",
      teamSubscription(teamId, sub, "prod_team_business_test", {
        current_period_start: start,
        current_period_end: end,
      })
    );
    expect((await teamRow(teamId)).request_limit).toBe(row.request_limit);

    // The renewal gives the full allowance.
    await deliver(
      "subscription.updated",
      teamSubscription(teamId, sub, "prod_team_business_test", {
        current_period_start: end,
        current_period_end: new Date(Date.now() + 45 * DAY).toISOString(),
      })
    );
    row = await teamRow(teamId);
    expect(row).toMatchObject({ request_limit: 500_000, prorated_window: null, requests_used: 0 });
    expect(await pageAllowance(teamId)).toBe(4_000);
  });

  it("stays on while a payment is past due", async () => {
    const { teamId } = await createTeam("biz-pd");
    const sub = `sub_tb_pd_${ts}`;
    await subscribeTeam(teamId, sub);
    await deliver(
      "subscription.updated",
      teamSubscription(teamId, sub, "prod_team_business_test", { status: "past_due" })
    );
    expect(await teamRow(teamId)).toMatchObject({
      business: true,
      subscription_status: "past_due",
      request_limit: 500_000,
    });
  });

  it("renews an annual team's quota monthly inside the year, and ends it with the year", async () => {
    const { teamId } = await createTeam("biz-year");
    const sub = `sub_tb_yr_${ts}`;
    const start = new Date(Date.now() - 40 * DAY).toISOString();
    const yearEnd = new Date(Date.now() + 325 * DAY).toISOString();
    await subscribeTeam(teamId, sub, "prod_team_business_year_test", {
      current_period_start: start,
      current_period_end: yearEnd,
    });
    let row = await teamRow(teamId);
    expect(row).toMatchObject({ billing_interval: "year", business: true });
    expect(new Date(String(row.billing_period_end)).toISOString()).toBe(yearEnd);
    // The quota period is the year's first month, already over here.
    expect(Date.parse(String(row.period_end))).toBeLessThan(Date.now());

    await admin.from("teams").update({ requests_used: 1234 }).eq("id", teamId);
    await admin.rpc("process_billing_period_resets");
    row = await teamRow(teamId);
    expect(row.subscription_status).toBe("active");
    expect(row.requests_used).toBe(0);
    expect(Date.parse(String(row.period_start))).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(String(row.period_end))).toBeGreaterThan(Date.now());
    expect(new Date(String(row.billing_period_end)).toISOString()).toBe(yearEnd);

    // Set to end: the monthly windows do not end it, the year does.
    await admin
      .from("teams")
      .update({ cancel_at_period_end: true, period_end: new Date(Date.now() - DAY).toISOString() })
      .eq("id", teamId);
    await admin.rpc("process_billing_period_resets");
    expect((await teamRow(teamId)).subscription_status).not.toBeNull();
    await admin
      .from("teams")
      .update({ billing_period_end: new Date(Date.now() - DAY).toISOString() })
      .eq("id", teamId);
    await admin.rpc("process_billing_period_resets");
    expect(await teamRow(teamId)).toMatchObject({
      subscription_status: null,
      business: false,
      billing_interval: null,
    });
  });

  it("records a downgrade Polar holds for the renewal", async () => {
    const { teamId } = await createTeam("biz-pending");
    const sub = `sub_tb_pend_${ts}`;
    polarMocks.createPolarClient.mockReturnValueOnce({
      subscriptions: {
        update: vi.fn(),
        revoke: vi.fn(),
        get: vi.fn().mockResolvedValue(
          teamSubscription(teamId, sub, "prod_team_business_test", {
            pending_update: { product_id: "prod_teams_test", seats: null },
          })
        ),
      },
    });
    await subscribeTeam(teamId, sub);
    expect(await teamRow(teamId)).toMatchObject({
      business: true,
      pending_plan: "team",
      pending_interval: "month",
    });
  });
});

describe("page add-ons when Business is about to end", () => {
  it("refuses renewing page add-ons while a change away from Business waits, and shows them ending", async () => {
    const userId = await createUser({ plan: "business", subscription_status: "active" });
    await applyAddon({ userId }, "page_blocks", `sub_pb_end_${ts}`, "active", 2);
    const account = { kind: "user" as const, userId };

    await admin
      .from("users")
      .update({ pending_plan: "pro", pending_interval: "month" })
      .eq("id", userId);
    expect((await getCapacityState(account, "pages")).planEnding).toBe(true);
    await expect(changeMonthlyBlocks(account, userId, 2, "pages")).rejects.toMatchObject({
      code: "plan_ending",
    });
    await expect(
      setOverage(account, userId, { enabled: true, maxRequests: 2000 }, "pages")
    ).rejects.toMatchObject({ code: "plan_ending" });

    // Business annual keeps pages; so does keeping Business.
    await admin
      .from("users")
      .update({ pending_plan: "business", pending_interval: "year" })
      .eq("id", userId);
    expect((await getCapacityState(account, "pages")).planEnding).toBe(false);
  });

  it("ends a team's page add-ons when its Team Business subscription is revoked", async () => {
    const { teamId } = await createTeam("biz-revoke");
    const account = { kind: "team" as const, teamId };
    const sub = `sub_tb_rev_${ts}`;
    await subscribeTeam(teamId, sub);
    await applyAddon(account, "page_blocks", `sub_tpb_rev_${ts}`, "active", 1);
    expect((await teamRow(teamId)).page_block_pages).toBe(1_000);

    await deliver(
      "subscription.revoked",
      teamSubscription(teamId, sub, "prod_team_business_test", {
        status: "canceled",
        ended_at: new Date().toISOString(),
      })
    );
    const { data: rows } = await admin
      .from("capacity_subscriptions")
      .select("kind, status, units")
      .eq("team_id", teamId);
    // Ended: the page blocks do not renew without Team Business.
    expect(rows).toEqual([{ kind: "page_blocks", status: null, units: 0 }]);
    expect(await teamRow(teamId)).toMatchObject({ business: false, page_block_pages: 0 });
  });

  it("sets a team's page add-ons to end with a move to Teams, and refuses new ones", async () => {
    const { owner, teamId } = await createTeam("biz-end");
    const account = { kind: "team" as const, teamId };
    await subscribeTeam(teamId, `sub_tb_end_${ts}`);
    await applyAddon(account, "page_blocks", `sub_tpb_end_${ts}`, "active", 1);

    await admin
      .from("teams")
      .update({ pending_plan: "team", pending_interval: "month" })
      .eq("id", teamId);
    await reconcileAddonsWithPlan(account);
    const { data: rows } = await admin
      .from("capacity_subscriptions")
      .select("kind, cancel_at_period_end")
      .eq("team_id", teamId);
    expect(rows).toEqual([{ kind: "page_blocks", cancel_at_period_end: true }]);
    expect((await getCapacityState(account, "pages")).planEnding).toBe(true);
    await expect(changeMonthlyBlocks(account, owner, 1, "pages")).rejects.toMatchObject({
      code: "plan_ending",
    });

    // Keeping Team Business brings them back.
    await admin
      .from("teams")
      .update({ pending_plan: null, pending_interval: null })
      .eq("id", teamId);
    await reconcileAddonsWithPlan(account);
    const { data: kept } = await admin
      .from("capacity_subscriptions")
      .select("cancel_at_period_end")
      .eq("team_id", teamId)
      .single();
    expect(kept?.cancel_at_period_end).toBe(false);
  });
});

describe("extra inbound domains", () => {
  async function allowed(account: { userId?: string; teamId?: string }) {
    const { data, error } = await admin.rpc("inbound_domains_allowed", {
      p_user_id: account.userId ?? null,
      p_team_id: account.teamId ?? null,
    });
    if (error) throw error;
    return data as number;
  }

  it("count only on Business, on top of the included domain", async () => {
    const userId = await createUser({ plan: "business", subscription_status: "active" });
    expect(await allowed({ userId })).toBe(1);
    expect(
      (await applyAddon({ userId }, "domain_blocks", `sub_db_${ts}`, "active", 2)).status
    ).toBe("ok");
    expect((await user(userId)).extra_domains).toBe(2);
    expect(await allowed({ userId })).toBe(3);
    const state = await getCapacityState({ kind: "user", userId }, "domains");
    expect(state).toMatchObject({ eligible: true, planRequests: 1, blockRequests: 2, used: 0 });
    expect(state.blocks).toMatchObject({ units: 2, pendingUnits: 2 });

    // Down to Pro: none included, and the extra ones stop counting.
    await admin.from("users").update({ plan: "pro" }).eq("id", userId);
    await admin.rpc("sync_capacity_account", { p_user_id: userId, p_team_id: null });
    expect((await user(userId)).extra_domains).toBe(0);
    expect(await allowed({ userId })).toBe(0);
  });

  it("raise the subscription when added mid-period, and record an add with nothing to raise", async () => {
    const userId = await createUser({ plan: "business", subscription_status: "active" });
    const grant = async (order: string) => {
      const { data, error } = await admin.rpc("grant_capacity_purchase", {
        p_order_id: order,
        p_user_id: userId,
        p_team_id: null,
        p_kind: "domain_increase",
        p_units: 1,
        p_amount: 300,
      });
      if (error) throw error;
      return data as Record<string, unknown>;
    };

    // No subscription to raise (it ended while the checkout was open).
    expect(await grant(`ord_dom_orphan_${ts}`)).toMatchObject({
      status: "ok",
      kind: "domain_increase",
      unapplied: true,
    });
    expect((await user(userId)).extra_domains).toBe(0);
    expect((await user(userId)).credit_requests).toBe(0);

    await applyAddon({ userId }, "domain_blocks", `sub_db_add_${ts}`, "active", 1);
    expect(await grant(`ord_dom_add_${ts}`)).toMatchObject({
      status: "ok",
      kind: "domain_increase",
      target_units: 2,
      synced: false,
    });
    expect((await user(userId)).extra_domains).toBe(2);
    // A redelivery grants nothing twice.
    expect(await grant(`ord_dom_add_${ts}`)).toMatchObject({ status: "duplicate" });
    expect((await user(userId)).extra_domains).toBe(2);
  });

  it("raise the subscription and Polar's renewal from a paid order for more", async () => {
    const userId = await createUser({ plan: "business", subscription_status: "active" });
    await applyAddon({ userId }, "domain_blocks", `sub_db_paid_${ts}`, "active", 1);
    const update = vi.fn().mockResolvedValue({});
    polarMocks.createPolarClient.mockReturnValue({
      subscriptions: { update, get: vi.fn(), revoke: vi.fn() },
    });
    try {
      await deliver("order.paid", {
        id: `ord_dom_paid_${ts}`,
        product_id: "prod_domains_add_test",
        units: 1,
        total_amount: 300,
        status: "paid",
        customer: { metadata: { userId } },
      });
    } finally {
      polarMocks.createPolarClient.mockReset();
      polarMocks.createPolarClient.mockImplementation(() => ({
        subscriptions: { update: vi.fn(), get: vi.fn(), revoke: vi.fn() },
      }));
    }
    const { data: purchase } = await admin
      .from("capacity_purchases")
      .select("kind, units, target_units, synced_at")
      .eq("polar_order_id", `ord_dom_paid_${ts}`)
      .single();
    expect(purchase).toMatchObject({ kind: "domain_increase", units: 1, target_units: 2 });
    expect(purchase!.synced_at).not.toBeNull();
    expect((await user(userId)).extra_domains).toBe(2);
    // The renewal charges for the raised count from the next period.
    expect(update).toHaveBeenCalledWith(`sub_db_paid_${ts}`, {
      units: 2,
      proration_behavior: "next_period",
    });
  });

  it("count for a team only with Team Business", async () => {
    const { owner, teamId } = await createTeam("dom");
    const account = { kind: "team" as const, teamId };
    const sub = `sub_tdb_tb_${ts}`;
    await subscribeTeam(teamId, sub, "prod_teams_test");

    await applyAddon(account, "domain_blocks", `sub_tdb_${ts}`, "active", 2);
    expect(await allowed(account)).toBe(0);
    await expect(changeMonthlyBlocks(account, owner, 3, "domains")).rejects.toMatchObject({
      code: "plan_required",
    });

    // Upgraded: the extra domains count at once (a trigger syncs them).
    await deliver("subscription.updated", teamSubscription(teamId, sub, "prod_team_business_test"));
    expect(await allowed(account)).toBe(3);

    // A move back to Teams waiting for the renewal: the extra domains end with it.
    await admin
      .from("teams")
      .update({ pending_plan: "team", pending_interval: "month" })
      .eq("id", teamId);
    await reconcileAddonsWithPlan(account);
    const { data: rows } = await admin
      .from("capacity_subscriptions")
      .select("kind, cancel_at_period_end, canceled_with_plan")
      .eq("team_id", teamId);
    expect(rows).toEqual([
      { kind: "domain_blocks", cancel_at_period_end: true, canceled_with_plan: true },
    ]);
    expect((await getCapacityState(account, "domains")).planEnding).toBe(true);
  });

  it("keep counting while the team's payment is past due, and end when it is revoked", async () => {
    const { teamId } = await createTeam("dom-pd");
    const account = { kind: "team" as const, teamId };
    const sub = `sub_tdp_tb_${ts}`;
    await subscribeTeam(teamId, sub);
    await applyAddon(account, "domain_blocks", `sub_tdp_db_${ts}`, "active", 1);
    const domainRow = async () =>
      (
        await admin
          .from("capacity_subscriptions")
          .select("status, cancel_at_period_end")
          .eq("polar_subscription_id", `sub_tdp_db_${ts}`)
          .single()
      ).data;
    expect(await allowed(account)).toBe(2);

    // A failed card: the team stays live while Polar retries it, and so
    // does its custom domain.
    await deliver(
      "subscription.updated",
      teamSubscription(teamId, sub, "prod_team_business_test", { status: "past_due" })
    );
    expect(await domainRow()).toEqual({ status: "active", cancel_at_period_end: false });
    expect(await allowed(account)).toBe(2);

    // Revoked mid-period: the extra domains end now, not at their renewal.
    await deliver(
      "subscription.revoked",
      teamSubscription(teamId, sub, "prod_team_business_test", {
        status: "canceled",
        ended_at: new Date().toISOString(),
      })
    );
    expect((await domainRow())?.status).toBeNull();
    expect(await allowed(account)).toBe(0);
  });

  it("keep a paid increase on blocks that ended meanwhile, and take it back on a refund", async () => {
    const userId = await createUser({ plan: "business", subscription_status: "active" });
    const account = { kind: "user" as const, userId };
    const subscriptionId = `sub_pb_gone_${ts}`;
    const orderId = `ord_pb_gone_${ts}`;
    await applyAddon(account, "page_blocks", subscriptionId, "active", 1);
    // Polar ended the subscription before the order's event arrived.
    polarMocks.createPolarClient.mockReturnValue({
      subscriptions: {
        update: vi.fn().mockRejectedValue(new Error("Subscription is already canceled.")),
        get: vi.fn().mockResolvedValue({ status: "canceled", ended_at: new Date().toISOString() }),
        revoke: vi.fn(),
      },
    });
    try {
      const order = { id: orderId, units: 1, total_amount: 500 };
      await applyCapacityWebhookEvent(
        "order.paid",
        account,
        { resource: "pages", kind: "monthly_add" },
        order
      );
      expect((await user(userId)).credit_pages).toBe(1000);
      // Redelivered: kept once.
      await applyCapacityWebhookEvent(
        "order.paid",
        account,
        { resource: "pages", kind: "monthly_add" },
        order
      );
      expect((await user(userId)).credit_pages).toBe(1000);

      await applyCapacityWebhookEvent(
        "order.refunded",
        account,
        { resource: "pages", kind: "monthly_add" },
        { id: orderId, status: "refunded" }
      );
      expect((await user(userId)).credit_pages).toBe(0);
    } finally {
      polarMocks.createPolarClient.mockReset();
      polarMocks.createPolarClient.mockImplementation(() => ({
        subscriptions: { update: vi.fn(), get: vi.fn(), revoke: vi.fn() },
      }));
    }
  });

  it("end with a change away from Business, and come back when Business is kept", async () => {
    const userId = await createUser({ plan: "business", subscription_status: "active" });
    await applyAddon({ userId }, "domain_blocks", `sub_db_end_${ts}`, "active", 1);
    const account = { kind: "user" as const, userId };

    await admin
      .from("users")
      .update({ pending_plan: "pro", pending_interval: "month" })
      .eq("id", userId);
    await reconcileAddonsWithPlan(account);
    const ending = async () =>
      (
        await admin
          .from("capacity_subscriptions")
          .select("cancel_at_period_end")
          .eq("polar_subscription_id", `sub_db_end_${ts}`)
          .single()
      ).data?.cancel_at_period_end;
    expect(await ending()).toBe(true);
    await expect(changeMonthlyBlocks(account, userId, 2, "domains")).rejects.toMatchObject({
      code: "plan_ending",
    });

    await admin
      .from("users")
      .update({ pending_plan: null, pending_interval: null })
      .eq("id", userId);
    await reconcileAddonsWithPlan(account);
    expect(await ending()).toBe(false);
  });
});

describe("add-ons on an annual plan", () => {
  it("keep renewing monthly until the year's last month when Business is leaving", async () => {
    const yearEnd = new Date(Date.now() + 200 * DAY).toISOString();
    const userId = await createUser({
      plan: "business",
      subscription_status: "active",
      billing_interval: "year",
      billing_period_end: yearEnd,
      period_start: new Date(Date.now() - 5 * DAY).toISOString(),
      period_end: new Date(Date.now() + 25 * DAY).toISOString(),
      pending_plan: "pro",
      pending_interval: "month",
    });
    const account = { kind: "user" as const, userId };
    await applyAddon(account, "page_blocks", `sub_pb_year_${ts}`, "active", 1);

    await reconcileAddonsWithPlan(account);
    const ending = async () =>
      (
        await admin
          .from("capacity_subscriptions")
          .select("cancel_at_period_end")
          .eq("polar_subscription_id", `sub_pb_year_${ts}`)
          .single()
      ).data?.cancel_at_period_end;
    expect(await ending()).toBe(false);
    expect((await getCapacityState(account, "pages")).planEnding).toBe(false);

    // The year's last month: the add-on's renewal moved its period there.
    await admin
      .from("users")
      .update({ period_start: new Date(Date.now() - DAY).toISOString(), period_end: yearEnd })
      .eq("id", userId);
    await admin
      .from("capacity_subscriptions")
      .update({ period_end: yearEnd })
      .eq("polar_subscription_id", `sub_pb_year_${ts}`);
    await reconcileAddonsWithPlan(account);
    expect(await ending()).toBe(true);
    expect((await getCapacityState(account, "pages")).planEnding).toBe(true);

    // Keeping Business brings them back.
    await admin
      .from("users")
      .update({ pending_plan: null, pending_interval: null })
      .eq("id", userId);
    await reconcileAddonsWithPlan(account);
    expect(await ending()).toBe(false);
  });

  it("ends an add-on whose next renewal would pass a plan end that drifted from its window", async () => {
    // The monthly windows drifted (counted before migration 00084): this one
    // ends 3 days before the year does, and the next would end a month
    // later, past it.
    const userId = await createUser({
      plan: "business",
      subscription_status: "active",
      billing_interval: "year",
      billing_period_end: new Date(Date.now() + 4 * DAY).toISOString(),
      period_start: new Date(Date.now() - 29 * DAY).toISOString(),
      period_end: new Date(Date.now() + DAY).toISOString(),
      cancel_at_period_end: true,
    });
    const account = { kind: "user" as const, userId };
    await applyAddon(account, "page_blocks", `sub_pb_drift_${ts}`, "active", 1);
    await admin
      .from("capacity_subscriptions")
      .update({ period_end: new Date(Date.now() + DAY).toISOString() })
      .eq("polar_subscription_id", `sub_pb_drift_${ts}`);

    await reconcileAddonsWithPlan(account);
    const { data } = await admin
      .from("capacity_subscriptions")
      .select("cancel_at_period_end")
      .eq("polar_subscription_id", `sub_pb_drift_${ts}`)
      .single();
    expect(data?.cancel_at_period_end).toBe(true);
  });

  it("keeps overage off when it was turned off while ending with the plan", async () => {
    const userId = await createUser({
      plan: "business",
      subscription_status: "active",
      pending_plan: "pro",
      pending_interval: "month",
      period_start: new Date(Date.now() - DAY).toISOString(),
      period_end: new Date(Date.now() + 29 * DAY).toISOString(),
    });
    const account = { kind: "user" as const, userId };
    await applyAddon(account, "page_overage", `sub_po_off_${ts}`, "active");
    await reconcileAddonsWithPlan(account);

    await setOverage(account, userId, { enabled: false }, "pages");
    await admin
      .from("users")
      .update({ pending_plan: null, pending_interval: null })
      .eq("id", userId);
    await reconcileAddonsWithPlan(account);

    const { data } = await admin
      .from("capacity_subscriptions")
      .select("cancel_at_period_end, canceled_with_plan")
      .eq("polar_subscription_id", `sub_po_off_${ts}`)
      .single();
    expect(data).toEqual({ cancel_at_period_end: true, canceled_with_plan: false });
  });
});
