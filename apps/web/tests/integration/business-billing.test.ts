import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * Business billing (migration 00070) against the local database: the plan
 * webhook for Business and its annual interval, page add-ons that count only
 * with Business, the Team Business add-on and the team pool, page overage
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
import {
  applyCapacityWebhookEvent,
  changeMonthlyBlocks,
  getCapacityState,
  reconcileAddonsWithPlan,
  setOverage,
  setTeamBusinessEnding,
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
    POLAR_TEAM_BUSINESS_PRODUCT_ID: "prod_team_business_test",
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
    const yearEnd = new Date(start.getTime() + 365 * DAY);
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
    // A month on as Postgres counts it, kept on the last day of a shorter
    // month (Oct 31 gives Nov 30), so the test holds on any day it runs.
    const monthEnd = new Date(start);
    monthEnd.setUTCDate(1);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
    const lastDay = new Date(
      Date.UTC(monthEnd.getUTCFullYear(), monthEnd.getUTCMonth() + 1, 0)
    ).getUTCDate();
    monthEnd.setUTCDate(Math.min(start.getUTCDate(), lastDay));
    expect(Date.parse(row.period_end as string)).toBe(monthEnd.getTime());

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
  it("makes a live team a Business team with the larger pool, and keeps its retention a week when it ends", async () => {
    const owner = await createUser();
    const { data: team, error } = await admin
      .from("teams")
      .insert({ name: `biz-${ts}`, created_by: owner, seats: 2, subscription_status: "active" })
      .select("id, request_limit")
      .single();
    if (error) throw error;
    teamIds.push(team.id);
    expect(team.request_limit).toBe(200_000);

    await applyAddon({ teamId: team.id }, "team_business", `sub_tb_${ts}`, "active");
    const { data: on } = await admin
      .from("teams")
      .select("business, request_limit")
      .eq("id", team.id)
      .single();
    expect(on).toEqual({ business: true, request_limit: 350_000 });

    // A seat change keeps the pool.
    await admin.rpc("update_team_seats", { p_team_id: team.id, p_seats: 3 });
    const { data: seats } = await admin
      .from("teams")
      .select("request_limit")
      .eq("id", team.id)
      .single();
    expect(seats?.request_limit).toBe(450_000);

    await applyAddon({ teamId: team.id }, "team_business", `sub_tb_${ts}`, null);
    const { data: off } = await admin
      .from("teams")
      .select("business, request_limit, retention_floor_days")
      .eq("id", team.id)
      .single();
    expect(off).toEqual({ business: false, request_limit: 300_000, retention_floor_days: 90 });
  });

  it("does nothing for a team without a live subscription", async () => {
    const owner = await createUser();
    const { data: team } = await admin
      .from("teams")
      .insert({ name: `biz-off-${ts}`, created_by: owner, seats: 1 })
      .select("id")
      .single();
    teamIds.push(team!.id);
    await applyAddon({ teamId: team!.id }, "team_business", `sub_tb_off_${ts}`, "active");
    const { data } = await admin.from("teams").select("business").eq("id", team!.id).single();
    expect(data?.business).toBe(false);
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

  it("ends a team's page add-ons when Team Business is revoked", async () => {
    const owner = await createUser();
    const { data: team, error } = await admin
      .from("teams")
      .insert({
        name: `biz-revoke-${ts}`,
        created_by: owner,
        seats: 1,
        subscription_status: "active",
      })
      .select("id")
      .single();
    if (error) throw error;
    teamIds.push(team.id);
    const account = { kind: "team" as const, teamId: team.id };
    await applyAddon(account, "team_business", `sub_tb_rev_${ts}`, "active");
    await applyAddon(account, "page_blocks", `sub_tpb_rev_${ts}`, "active", 1);

    await deliver("subscription.revoked", {
      id: `sub_tb_rev_${ts}`,
      customer_id: `cus_tb_rev_${ts}`,
      customer: { metadata: { teamId: team.id } },
      product_id: "prod_team_business_test",
      status: "canceled",
      cancel_at_period_end: false,
    });
    const { data: rows } = await admin
      .from("capacity_subscriptions")
      .select("kind, status, units")
      .eq("team_id", team.id)
      .order("kind");
    // Both ended: the page blocks do not renew without Team Business.
    expect(rows).toEqual([
      { kind: "page_blocks", status: null, units: 0 },
      { kind: "team_business", status: null, units: 0 },
    ]);
  });

  it("sets a team's page add-ons to end with Team Business", async () => {
    const owner = await createUser();
    const { data: team, error } = await admin
      .from("teams")
      .insert({ name: `biz-end-${ts}`, created_by: owner, seats: 1, subscription_status: "active" })
      .select("id")
      .single();
    if (error) throw error;
    teamIds.push(team.id);
    const account = { kind: "team" as const, teamId: team.id };
    await applyAddon(account, "team_business", `sub_tb_end_${ts}`, "active");
    await applyAddon(account, "page_blocks", `sub_tpb_end_${ts}`, "active", 1);

    await setTeamBusinessEnding(account, true);
    const { data: rows } = await admin
      .from("capacity_subscriptions")
      .select("kind, cancel_at_period_end")
      .eq("team_id", team.id)
      .order("kind");
    expect(rows).toEqual([
      { kind: "page_blocks", cancel_at_period_end: true },
      { kind: "team_business", cancel_at_period_end: true },
    ]);
    expect((await getCapacityState(account, "pages")).planEnding).toBe(true);
    await expect(changeMonthlyBlocks(account, owner, 1, "pages")).rejects.toMatchObject({
      code: "plan_ending",
    });
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

  it("count for a team only with Team Business", async () => {
    const owner = await createUser();
    const { data: team, error } = await admin
      .from("teams")
      .insert({ name: `dom-${ts}`, created_by: owner, seats: 1, subscription_status: "active" })
      .select("id")
      .single();
    if (error) throw error;
    teamIds.push(team.id);
    const account = { kind: "team" as const, teamId: team.id };

    await applyAddon(account, "domain_blocks", `sub_tdb_${ts}`, "active", 2);
    expect(await allowed(account)).toBe(0);
    await expect(changeMonthlyBlocks(account, owner, 3, "domains")).rejects.toMatchObject({
      code: "plan_required",
    });

    await applyAddon(account, "team_business", `sub_tdb_tb_${ts}`, "active");
    expect(await allowed(account)).toBe(3);

    // Team Business set to end: the extra domains end with it.
    await setTeamBusinessEnding(account, true);
    const { data: rows } = await admin
      .from("capacity_subscriptions")
      .select("kind, cancel_at_period_end, canceled_with_plan")
      .eq("team_id", team.id)
      .order("kind");
    expect(rows).toEqual([
      { kind: "domain_blocks", cancel_at_period_end: true, canceled_with_plan: true },
      { kind: "team_business", cancel_at_period_end: true, canceled_with_plan: false },
    ]);
    expect((await getCapacityState(account, "domains")).planEnding).toBe(true);
  });

  it("wait while Team Business is behind on payment, and end when it is revoked", async () => {
    const owner = await createUser();
    const { data: team, error } = await admin
      .from("teams")
      .insert({ name: `dom-pd-${ts}`, created_by: owner, seats: 1, subscription_status: "active" })
      .select("id")
      .single();
    if (error) throw error;
    teamIds.push(team.id);
    const account = { kind: "team" as const, teamId: team.id };
    await applyAddon(account, "team_business", `sub_tdp_tb_${ts}`, "active");
    await applyAddon(account, "domain_blocks", `sub_tdp_db_${ts}`, "active", 1);
    const domainRow = async () =>
      (
        await admin
          .from("capacity_subscriptions")
          .select("status, cancel_at_period_end")
          .eq("polar_subscription_id", `sub_tdp_db_${ts}`)
          .single()
      ).data;

    // A failed card: Team Business stops counting, the extra domains wait.
    await applyAddon(account, "team_business", `sub_tdp_tb_${ts}`, "past_due");
    await reconcileAddonsWithPlan(account);
    expect(await domainRow()).toEqual({ status: "active", cancel_at_period_end: false });
    expect(await allowed(account)).toBe(0);
    await applyAddon(account, "team_business", `sub_tdp_tb_${ts}`, "active");
    expect(await allowed(account)).toBe(2);

    // Revoked mid-period: the extra domains end now, not at their renewal.
    await applyCapacityWebhookEvent(
      "subscription.revoked",
      account,
      { resource: "team", kind: "team_business" },
      { id: `sub_tdp_tb_${ts}`, status: "canceled", ended_at: new Date().toISOString() }
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
    polarMocks.createPolarClient.mockReturnValueOnce({
      subscriptions: {
        update: vi.fn().mockRejectedValue(new Error("Subscription is already canceled.")),
        get: vi.fn(),
        revoke: vi.fn(),
      },
    });
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
    // The monthly windows drifted: this one ends 3 days before the year does,
    // and the next would end a month later, past it.
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

  it("brings a team's page add-ons back when Team Business is kept", async () => {
    const owner = await createUser();
    const { data: team, error } = await admin
      .from("teams")
      .insert({
        name: `biz-keep-${ts}`,
        created_by: owner,
        seats: 1,
        subscription_status: "active",
      })
      .select("id")
      .single();
    if (error) throw error;
    teamIds.push(team.id);
    const account = { kind: "team" as const, teamId: team.id };
    await applyAddon(account, "team_business", `sub_tb_keep_${ts}`, "active");
    await applyAddon(account, "page_overage", `sub_tpo_keep_${ts}`, "active");

    await setTeamBusinessEnding(account, true);
    await setTeamBusinessEnding(account, false);
    const { data: rows } = await admin
      .from("capacity_subscriptions")
      .select("kind, cancel_at_period_end")
      .eq("team_id", team.id)
      .order("kind");
    expect(rows).toEqual([
      { kind: "page_overage", cancel_at_period_end: false },
      { kind: "team_business", cancel_at_period_end: false },
    ]);
  });
});
