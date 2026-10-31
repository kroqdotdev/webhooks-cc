import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { BLOCK_REQUESTS } from "@/lib/capacity";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { getUsageForUser } from "@/lib/supabase/usage";

// Extra request capacity (migration 00065): the order captures spend it in,
// the email check that mirrors it, and the RPCs the Polar webhook calls.

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
const createdEndpointIds: string[] = [];
let sequence = 0;

afterAll(async () => {
  if (createdEndpointIds.length > 0) {
    await admin.from("endpoint_daily_stats").delete().in("endpoint_id", createdEndpointIds);
    await admin.from("requests").delete().in("endpoint_id", createdEndpointIds);
    await admin.from("team_endpoints").delete().in("endpoint_id", createdEndpointIds);
    await admin.from("endpoints").delete().in("id", createdEndpointIds);
  }
  if (createdTeamIds.length > 0) {
    await admin.from("teams").delete().in("id", createdTeamIds);
  }
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

async function createTestUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-capacity-${label}-${ts}-${++sequence}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  createdUserIds.push(data.user!.id);
  return data.user!.id;
}

async function createTestEndpoint(userId: string) {
  const endpoint = await createEndpointForUser({ userId, name: "capacity endpoint" });
  createdEndpointIds.push(endpoint.id);
  return endpoint;
}

async function createTestTeam(ownerId: string): Promise<string> {
  const { data, error } = await admin.rpc("create_team_with_owner", {
    p_user_id: ownerId,
    p_name: `Capacity ${ts}-${++sequence}`,
  });
  if (error) throw error;
  const team = data as { id?: string; error?: string };
  if (!team.id) throw new Error(`create_team_with_owner failed: ${team.error}`);
  createdTeamIds.push(team.id);
  return team.id;
}

const periodStart = () => new Date(Date.now() - 24 * 3600_000).toISOString();
const periodEnd = () => new Date(Date.now() + 29 * 24 * 3600_000).toISOString();

async function makePro(userId: string, requestLimit: number) {
  const { error } = await admin
    .from("users")
    .update({
      plan: "pro",
      subscription_status: "active",
      polar_customer_id: `cus_capacity_${userId}`,
      polar_subscription_id: `sub_pro_${userId}`,
      request_limit: requestLimit,
      requests_used: 0,
      period_start: periodStart(),
      period_end: periodEnd(),
    })
    .eq("id", userId);
  if (error) throw error;
}

async function capture(slug: string): Promise<string> {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "POST",
    p_path: "/",
    p_headers: { "content-type": "application/json" },
    p_body: "{}",
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "127.0.0.1",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
  });
  if (error) throw error;
  return (data as { status: string }).status;
}

async function emailCheck(slug: string): Promise<string> {
  const { data, error } = await admin.rpc("check_email_recipient", { p_slug: slug });
  if (error) throw error;
  return (data as { status: string }).status;
}

async function applySubscription(
  account: { userId?: string; teamId?: string },
  kind: "blocks" | "overage",
  subscriptionId: string,
  overrides: Record<string, unknown> = {}
) {
  const { data, error } = await admin.rpc("apply_capacity_subscription", {
    p_user_id: account.userId ?? null,
    p_team_id: account.teamId ?? null,
    p_kind: kind,
    p_subscription_id: subscriptionId,
    p_status: "active",
    p_units: kind === "blocks" ? 1 : 0,
    p_pending_units: null,
    p_cancel_at_period_end: false,
    p_period_start: periodStart(),
    p_period_end: periodEnd(),
    ...overrides,
  });
  if (error) throw error;
  return (data as { status: string }).status;
}

async function userRow(userId: string) {
  const { data, error } = await admin
    .from("users")
    .select(
      "requests_used, block_requests, credit_requests, overage_active, overage_max, overage_used, overage_total, overage_reported"
    )
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data;
}

describe("captures past the allowance", () => {
  let userId: string;
  let slug: string;

  beforeEach(async () => {
    userId = await createTestUser("order");
    slug = (await createTestEndpoint(userId)).slug;
    await makePro(userId, 2);
  });

  it("spends the allowance, then recurring blocks, then one-time blocks, then overage", async () => {
    expect(await applySubscription({ userId }, "blocks", `sub_blocks_${userId}`)).toBe("ok");
    expect(await applySubscription({ userId }, "overage", `sub_overage_${userId}`)).toBe("ok");
    expect((await userRow(userId)).block_requests).toBe(BLOCK_REQUESTS);

    // Shrink the pieces so the order shows in a handful of captures.
    await admin
      .from("users")
      .update({ block_requests: 1, credit_requests: 2, overage_max: 2 })
      .eq("id", userId);

    const statuses: string[] = [];
    const credits: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push(await capture(slug));
      credits.push(Number((await userRow(userId)).credit_requests));
    }

    expect(statuses).toEqual([
      "ok", // plan
      "ok", // plan
      "ok", // monthly block
      "ok", // one-time
      "ok", // one-time
      "ok", // overage
      "ok", // overage
      "quota_exceeded",
    ]);
    expect(credits).toEqual([2, 2, 2, 1, 0, 0, 0, 0]);

    const row = await userRow(userId);
    // requests_used keeps counting the allowance only.
    expect(row.requests_used).toBe(3);
    expect(row.overage_used).toBe(2);
    expect(Number(row.overage_total)).toBe(2);
    expect(await emailCheck(slug)).toBe("over_quota");

    const usage = await getUsageForUser(userId);
    expect(usage).toMatchObject({
      used: 3,
      limit: 3,
      remaining: 0,
      creditRequests: 0,
      overage: { active: true, used: 2, max: 2 },
    });
  });

  it("lets the email check through while a one-time block is left", async () => {
    await admin.from("users").update({ requests_used: 2, credit_requests: 1 }).eq("id", userId);
    expect(await emailCheck(slug)).toBe("ok");

    await admin.from("users").update({ credit_requests: 0 }).eq("id", userId);
    expect(await emailCheck(slug)).toBe("over_quota");
  });

  it("keeps one-time blocks usable after the plan ends, but not recurring blocks or overage", async () => {
    await applySubscription({ userId }, "blocks", `sub_blocks_${userId}`);
    await applySubscription({ userId }, "overage", `sub_overage_${userId}`);
    await admin
      .from("users")
      .update({
        plan: "free",
        subscription_status: null,
        request_limit: 1,
        requests_used: 1,
        credit_requests: 1,
        overage_max: 10,
      })
      .eq("id", userId);
    await admin.rpc("sync_capacity_account", { p_user_id: userId, p_team_id: null });

    const row = await userRow(userId);
    expect(row.block_requests).toBe(0);
    expect(row.overage_active).toBe(false);

    expect(await capture(slug)).toBe("ok");
    expect(await capture(slug)).toBe("quota_exceeded");
  });
});

describe("a team pool past its allowance", () => {
  it("bills one-time blocks and overage to the team, and stops when the team is inactive", async () => {
    const ownerId = await createTestUser("team-owner");
    const teamId = await createTestTeam(ownerId);
    const endpoint = await createTestEndpoint(ownerId);
    await admin.from("team_endpoints").insert({
      team_id: teamId,
      endpoint_id: endpoint.id,
      shared_by: ownerId,
    });
    await admin
      .from("teams")
      .update({
        subscription_status: "active",
        // request_limit follows the seats (trigger teams_request_limit), so
        // the pool is used up rather than set small.
        seats: 1,
        requests_used: 100_000,
        credit_requests: 1,
        polar_customer_id: `cus_team_${teamId}`,
        period_start: periodStart(),
        period_end: periodEnd(),
      })
      .eq("id", teamId);
    await applySubscription({ teamId }, "overage", `sub_team_overage_${teamId}`);
    await admin.from("teams").update({ overage_max: 1 }).eq("id", teamId);

    expect(await capture(endpoint.slug)).toBe("ok"); // one-time
    expect(await capture(endpoint.slug)).toBe("ok"); // overage
    expect(await emailCheck(endpoint.slug)).toBe("over_quota");
    expect(await capture(endpoint.slug)).toBe("quota_exceeded");

    const { data: team } = await admin
      .from("teams")
      .select("credit_requests, overage_used, overage_total")
      .eq("id", teamId)
      .single();
    expect(team).toMatchObject({ credit_requests: 0, overage_used: 1 });

    const { data: billed } = await admin
      .from("requests")
      .select("team_id")
      .eq("endpoint_id", endpoint.id);
    expect((billed ?? []).every((row) => row.team_id === teamId)).toBe(true);
    expect(billed).toHaveLength(2);
  });
});

describe("apply_capacity_subscription", () => {
  it("only grows units within a period, takes Polar's count at a renewal, and never revives an ended row", async () => {
    const userId = await createTestUser("apply");
    await makePro(userId, 100);
    const sub = `sub_apply_${userId}`;
    const start = periodStart();

    await applySubscription({ userId }, "blocks", sub, { p_units: 3, p_period_start: start });
    // A paid increase raised the row to 3; Polar still says 2 until the renewal.
    await applySubscription({ userId }, "blocks", sub, {
      p_units: 2,
      p_pending_units: 1,
      p_period_start: start,
    });
    let { data: row } = await admin
      .from("capacity_subscriptions")
      .select("units, pending_units")
      .eq("polar_subscription_id", sub)
      .single();
    expect(row).toEqual({ units: 3, pending_units: 1 });

    const renewal = new Date(Date.parse(start) + 30 * 24 * 3600_000).toISOString();
    await applySubscription({ userId }, "blocks", sub, { p_units: 1, p_period_start: renewal });
    ({ data: row } = await admin
      .from("capacity_subscriptions")
      .select("units, pending_units")
      .eq("polar_subscription_id", sub)
      .single());
    expect(row).toEqual({ units: 1, pending_units: null });
    expect((await userRow(userId)).block_requests).toBe(BLOCK_REQUESTS);

    expect(await applySubscription({ userId }, "blocks", sub, { p_status: null })).toBe("ok");
    expect((await userRow(userId)).block_requests).toBe(0);
    expect(await applySubscription({ userId }, "blocks", sub)).toBe("ended");
  });

  it("ignores a delivery read before the renewal the row already has", async () => {
    const userId = await createTestUser("stale");
    await makePro(userId, 100);
    const sub = `sub_stale_${userId}`;
    const start = periodStart();
    const renewal = new Date(Date.parse(start) + 30 * 24 * 3600_000).toISOString();

    await applySubscription({ userId }, "blocks", sub, { p_units: 2, p_period_start: renewal });
    expect(
      await applySubscription({ userId }, "blocks", sub, { p_units: 5, p_period_start: start })
    ).toBe("stale");
    const { data: row } = await admin
      .from("capacity_subscriptions")
      .select("units")
      .eq("polar_subscription_id", sub)
      .single();
    expect(row).toEqual({ units: 2 });
  });

  it("grants no blocks while a payment is failing, or once Polar has gone quiet for two days", async () => {
    const userId = await createTestUser("dunning");
    await makePro(userId, 100);
    const sub = `sub_dunning_${userId}`;

    await applySubscription({ userId }, "blocks", sub, { p_status: "past_due", p_units: 2 });
    expect((await userRow(userId)).block_requests).toBe(0);

    await applySubscription({ userId }, "blocks", sub, { p_status: "active", p_units: 2 });
    expect((await userRow(userId)).block_requests).toBe(2 * BLOCK_REQUESTS);

    // The period ended three days ago and no renewal arrived.
    await admin
      .from("capacity_subscriptions")
      .update({ period_end: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() })
      .eq("polar_subscription_id", sub);
    await admin.rpc("process_billing_period_resets");
    expect((await userRow(userId)).block_requests).toBe(0);
  });

  it("does not move units on an event without period bounds", async () => {
    const userId = await createTestUser("no-bounds");
    await makePro(userId, 100);
    const sub = `sub_nobounds_${userId}`;
    await applySubscription({ userId }, "blocks", sub, { p_units: 2 });
    await applySubscription({ userId }, "blocks", sub, {
      p_units: 9,
      p_period_start: null,
      p_period_end: null,
    });
    const { data: row } = await admin
      .from("capacity_subscriptions")
      .select("units")
      .eq("polar_subscription_id", sub)
      .single();
    expect(row).toEqual({ units: 2 });
  });

  it("refuses a second live subscription of the same kind", async () => {
    const userId = await createTestUser("duplicate");
    await makePro(userId, 100);
    expect(await applySubscription({ userId }, "overage", `sub_first_${userId}`)).toBe("ok");
    expect(await applySubscription({ userId }, "overage", `sub_second_${userId}`)).toBe(
      "duplicate"
    );
  });
});

describe("grant_capacity_purchase and refund_capacity_purchase", () => {
  async function grant(
    orderId: string,
    userId: string,
    kind: "credits" | "block_increase",
    units: number
  ) {
    const { data, error } = await admin.rpc("grant_capacity_purchase", {
      p_order_id: orderId,
      p_user_id: userId,
      p_team_id: null,
      p_kind: kind,
      p_units: units,
      p_amount: 300 * units,
    });
    if (error) throw error;
    return data as Record<string, unknown>;
  }

  it("grants a one-time order once, and takes back what is left when it is refunded", async () => {
    const userId = await createTestUser("credits");
    const orderId = `ord_${userId}`;
    expect(await grant(orderId, userId, "credits", 2)).toMatchObject({ status: "ok" });
    expect(await grant(orderId, userId, "credits", 2)).toMatchObject({ status: "duplicate" });
    expect(Number((await userRow(userId)).credit_requests)).toBe(2 * BLOCK_REQUESTS);

    await admin.from("users").update({ credit_requests: 1000 }).eq("id", userId);
    const { data } = await admin.rpc("refund_capacity_purchase", { p_order_id: orderId });
    expect(data).toMatchObject({ status: "ok", kind: "credits" });
    expect(Number((await userRow(userId)).credit_requests)).toBe(0);
  });

  it("adds paid blocks to the live subscription and returns the count to renew at", async () => {
    const userId = await createTestUser("increase");
    await makePro(userId, 100);
    const sub = `sub_increase_${userId}`;
    await applySubscription({ userId }, "blocks", sub, { p_units: 2 });

    const result = await grant(`ord_inc_${userId}`, userId, "block_increase", 3);
    expect(result).toMatchObject({
      status: "ok",
      kind: "block_increase",
      subscription_id: sub,
      target_units: 5,
      synced: false,
    });
    expect((await userRow(userId)).block_requests).toBe(5 * BLOCK_REQUESTS);

    // A repeat reports what was recorded, so the webhook can finish the sync.
    expect(await grant(`ord_inc_${userId}`, userId, "block_increase", 3)).toMatchObject({
      status: "duplicate",
      target_units: 5,
      synced: false,
    });
  });

  it("keeps an increase as one-time blocks when the subscription is behind on payment", async () => {
    const userId = await createTestUser("past-due-increase");
    await makePro(userId, 100);
    await applySubscription({ userId }, "blocks", `sub_pd_${userId}`, {
      p_status: "past_due",
      p_units: 2,
    });

    const result = await grant(`ord_pd_${userId}`, userId, "block_increase", 1);
    expect(result).toMatchObject({ status: "ok", kind: "credits" });
    expect(Number((await userRow(userId)).credit_requests)).toBe(BLOCK_REQUESTS);
  });

  it("keeps an increase as one-time blocks when the subscription ended before the payment", async () => {
    const userId = await createTestUser("late-increase");
    const result = await grant(`ord_late_${userId}`, userId, "block_increase", 1);
    expect(result).toMatchObject({ status: "ok", kind: "credits" });
    expect(Number((await userRow(userId)).credit_requests)).toBe(BLOCK_REQUESTS);
  });
});

describe("overage reports", () => {
  it("leases an account's unreported range once and confirms it", async () => {
    const userId = await createTestUser("report");
    await makePro(userId, 100);
    await admin.from("users").update({ overage_total: 7, overage_reported: 3 }).eq("id", userId);

    const { data: first } = await admin.rpc("claim_overage_reports", {
      p_limit: 500,
      p_lease_seconds: 60,
    });
    const mine = (first ?? []).filter((row: { account_id: string }) => row.account_id === userId);
    expect(mine).toEqual([
      {
        account_kind: "user",
        account_id: userId,
        polar_customer_id: `cus_capacity_${userId}`,
        from_total: 3,
        to_total: 7,
      },
    ]);

    // Leased: a second poll does not hand it out again.
    const { data: second } = await admin.rpc("claim_overage_reports", {
      p_limit: 500,
      p_lease_seconds: 60,
    });
    expect((second ?? []).some((row: { account_id: string }) => row.account_id === userId)).toBe(
      false
    );

    await admin.rpc("complete_overage_report", {
      p_account_kind: "user",
      p_account_id: userId,
      p_to_total: 7,
    });
    const row = await userRow(userId);
    expect(Number(row.overage_reported)).toBe(7);
  });
});
