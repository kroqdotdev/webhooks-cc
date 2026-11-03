import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * Refunds for charges that bought nothing (migration 00086) against the local
 * database: the queue's functions (claim, approve, dismiss), and the Polar
 * webhook paths that record a refund. Polar is mocked. Automatic refunds are
 * off here (POLAR_AUTO_REFUNDS unset), so every refund is held for a person.
 */

const polarMocks = vi.hoisted(() => ({
  get: vi.fn(),
  revoke: vi.fn(),
  validateEvent: vi.fn(),
}));

vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  return {
    ...actual,
    createPolarClient: () => ({
      subscriptions: { get: polarMocks.get, revoke: polarMocks.revoke, update: vi.fn() },
    }),
    getPolarWebhookSecret: () => "whsec_test",
    loggablePolarError: (error: unknown) => error,
  };
});

vi.mock("@polar-sh/sdk/2026-10", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polar-sh/sdk/2026-10")>();
  return { ...actual, webhooks: { ...actual.webhooks, validateEvent: polarMocks.validateEvent } };
});

import { POST as polarWebhookRoute } from "@/app/api/polar-webhook/route";

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
const targets: string[] = [];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries({
    POLAR_PRO_PRODUCT_ID: "prod_pro_test",
    POLAR_TEAMS_PRODUCT_ID: "prod_teams_test",
    POLAR_REQUEST_BLOCKS_PRODUCT_ID: "prod_blocks_test",
    POLAR_MONTHLY_BLOCKS_PRODUCT_ID: "prod_monthly_blocks_test",
    POLAR_MONTHLY_BLOCKS_ADD_PRODUCT_ID: "prod_monthly_blocks_add_test",
    POLAR_OVERAGE_PRODUCT_ID: "prod_overage_test",
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
  if (targets.length > 0) await admin.from("polar_refunds").delete().in("target", targets);
  for (const id of teamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function createUser(fields: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-refunds-${counter}-${ts}@webhooks-test.local`,
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

async function refundRow(target: string) {
  const { data, error } = await admin
    .from("polar_refunds")
    .select("*")
    .eq("target", target)
    .maybeSingle();
  if (error) throw error;
  return data as Record<string, unknown> | null;
}

async function insertRow(fields: Record<string, unknown>) {
  targets.push(String(fields.target));
  const { data, error } = await admin.from("polar_refunds").insert(fields).select("*").single();
  if (error) throw error;
  return data as Record<string, unknown>;
}

function subscription(id: string, customer: Record<string, unknown>, product: string) {
  return {
    id,
    customer_id: `cus_${id}`,
    customer,
    product_id: product,
    status: "active",
    current_period_start: new Date().toISOString(),
    current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    cancel_at_period_end: false,
    seats: 2,
  };
}

describe("the refund queue", () => {
  it("claims due pending rows and unprepared held rows, once, and counts the attempt", async () => {
    const pending = await insertRow({
      target: `order:claim_pending_${ts}`,
      reason: "deleted_account",
      status: "pending",
    });
    const held = await insertRow({
      target: `order:claim_held_${ts}`,
      reason: "deleted_account",
      status: "held",
      hold_reason: "manual",
    });
    const prepared = await insertRow({
      target: `order:claim_prepared_${ts}`,
      reason: "deleted_account",
      status: "held",
      hold_reason: "manual",
      orders: [],
      planned_cents: 0,
    });
    const later = await insertRow({
      target: `order:claim_later_${ts}`,
      reason: "deleted_account",
      status: "pending",
      next_attempt_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const done = await insertRow({
      target: `order:claim_done_${ts}`,
      reason: "deleted_account",
      status: "refunded",
    });

    // Other suites may leave rows of their own: only ours are checked.
    const { data, error } = await admin.rpc("claim_polar_refunds", {
      p_limit: 100,
      p_lease_seconds: 60,
    });
    if (error) throw error;
    const claimed = new Map(
      (data as Array<{ id: string; attempts: number }>).map((row) => [row.id, row])
    );
    expect(claimed.has(String(pending.id))).toBe(true);
    expect(claimed.has(String(held.id))).toBe(true);
    expect(claimed.get(String(pending.id))?.attempts).toBe(1);
    for (const row of [prepared, later, done]) expect(claimed.has(String(row.id))).toBe(false);

    // Leased: a second worker gets neither.
    const { data: again } = await admin.rpc("claim_polar_refunds", {
      p_limit: 100,
      p_lease_seconds: 60,
    });
    const ids = new Set((again as Array<{ id: string }>).map((row) => row.id));
    expect(ids.has(String(pending.id))).toBe(false);
    expect(ids.has(String(held.id))).toBe(false);
  });

  it("lets a person approve or dismiss a held row, and nothing else", async () => {
    const held = await insertRow({
      target: `subscription:approve_${ts}`,
      reason: "duplicate_plan",
      status: "held",
      hold_reason: "over_cap",
      orders: [{ order_id: "o1", net: 50_000 }],
      planned_cents: 50_000,
      attempts: 3,
    });
    const { data: approved } = await admin.rpc("approve_polar_refund", { p_id: held.id });
    expect(approved).toBe(true);
    expect(await refundRow(String(held.target))).toMatchObject({
      status: "pending",
      attempts: 0,
      planned_cents: 50_000,
    });
    expect((await refundRow(String(held.target)))?.approved_at).not.toBeNull();

    // Nothing prepared yet: nobody saw what it would refund.
    const unprepared = await insertRow({
      target: `order:approve_unprepared_${ts}`,
      reason: "deleted_account",
      status: "held",
      hold_reason: "manual",
    });
    const { data: notYet } = await admin.rpc("approve_polar_refund", { p_id: unprepared.id });
    expect(notYet).toBe(false);
    expect(await refundRow(String(unprepared.target))).toMatchObject({ status: "held" });

    const refunded = await insertRow({
      target: `order:approve_done_${ts}`,
      reason: "deleted_account",
      status: "refunded",
    });
    const { data: refused } = await admin.rpc("approve_polar_refund", { p_id: refunded.id });
    expect(refused).toBe(false);

    const toDismiss = await insertRow({
      target: `order:dismiss_${ts}`,
      reason: "deleted_account",
      status: "held",
      hold_reason: "manual",
    });
    const { data: dismissed } = await admin.rpc("dismiss_polar_refund", { p_id: toDismiss.id });
    expect(dismissed).toBe(true);
    expect(await refundRow(String(toDismiss.target))).toMatchObject({ status: "dismissed" });
  });

  it("keeps one row per target", async () => {
    await insertRow({ target: `order:unique_${ts}`, reason: "deleted_account", status: "held" });
    const { error } = await admin
      .from("polar_refunds")
      .insert({ target: `order:unique_${ts}`, reason: "deleted_account", status: "held" });
    expect(error?.code).toBe("23505");
  });
});

describe("webhooks that record a refund", () => {
  it("a second plan subscription is revoked and held for review, once", async () => {
    const userId = await createUser();
    const first = subscription(`sub_first_${ts}`, { metadata: { userId } }, "prod_pro_test");
    polarMocks.get.mockResolvedValue(first);
    await deliver("subscription.created", first);

    const second = subscription(`sub_second_${ts}`, { metadata: { userId } }, "prod_pro_test");
    targets.push(`subscription:${second.id}`);
    polarMocks.get.mockImplementation(async (id: string) => (id === first.id ? first : second));
    await deliver("subscription.created", second);
    await deliver("subscription.updated", second);

    expect(polarMocks.revoke).toHaveBeenCalledWith(second.id);
    expect(await refundRow(`subscription:${second.id}`)).toMatchObject({
      reason: "duplicate_plan",
      user_id: userId,
      status: "held",
      hold_reason: "manual",
    });
    const { count } = await admin
      .from("polar_refunds")
      .select("id", { count: "exact", head: true })
      .eq("target", `subscription:${second.id}`);
    expect(count).toBe(1);
    const { data: account } = await admin
      .from("users")
      .select("polar_subscription_id")
      .eq("id", userId)
      .single();
    expect(account?.polar_subscription_id).toBe(first.id);
  });

  it("a plan subscription for a deleted account is revoked and held for review", async () => {
    const goneUserId = crypto.randomUUID();
    const orphan = subscription(
      `sub_orphan_${ts}`,
      { metadata: { userId: goneUserId } },
      "prod_pro_test"
    );
    targets.push(`subscription:${orphan.id}`);
    polarMocks.get.mockResolvedValue(orphan);
    polarMocks.revoke.mockClear();

    await deliver("subscription.created", orphan);

    expect(polarMocks.revoke).toHaveBeenCalledWith(orphan.id);
    expect(await refundRow(`subscription:${orphan.id}`)).toMatchObject({
      reason: "deleted_account",
      user_id: goneUserId,
      status: "held",
    });
  });

  it("a late event for a deleted account's own, already ended subscription records nothing", async () => {
    const goneUserId = crypto.randomUUID();
    const ended = subscription(
      `sub_ended_${ts}`,
      { metadata: { userId: goneUserId } },
      "prod_pro_test"
    );
    targets.push(`subscription:${ended.id}`);
    polarMocks.get.mockResolvedValue({
      ...ended,
      status: "canceled",
      ended_at: new Date().toISOString(),
    });
    polarMocks.revoke.mockClear();

    await deliver("subscription.updated", ended);

    expect(polarMocks.revoke).not.toHaveBeenCalled();
    expect(await refundRow(`subscription:${ended.id}`)).toBeNull();
  });

  it("a team subscription for a deleted team is revoked and held for review", async () => {
    const goneTeamId = crypto.randomUUID();
    const orphan = subscription(
      `sub_team_orphan_${ts}`,
      { external_id: `team:${goneTeamId}`, metadata: { teamId: goneTeamId } },
      "prod_teams_test"
    );
    targets.push(`subscription:${orphan.id}`);
    polarMocks.get.mockResolvedValue(orphan);
    polarMocks.revoke.mockClear();

    await deliver("subscription.created", orphan);

    expect(polarMocks.revoke).toHaveBeenCalledWith(orphan.id);
    expect(await refundRow(`subscription:${orphan.id}`)).toMatchObject({
      reason: "deleted_account",
      team_id: goneTeamId,
      user_id: null,
      status: "held",
    });
  });

  it("the late end of a deleted team's own add-on records nothing", async () => {
    // Team deletion revokes its add-ons, then the row goes; their events follow.
    const goneTeamId = crypto.randomUUID();
    const addon = {
      ...subscription(
        `sub_addon_gone_${ts}`,
        { external_id: `team:${goneTeamId}`, metadata: { teamId: goneTeamId } },
        "prod_monthly_blocks_test"
      ),
      units: 2,
      status: "canceled",
      ended_at: new Date().toISOString(),
    };
    targets.push(`subscription:${addon.id}`);
    polarMocks.get.mockResolvedValue(addon);
    polarMocks.revoke.mockClear();

    await deliver("subscription.revoked", addon);
    await deliver("subscription.updated", addon);

    expect(polarMocks.revoke).not.toHaveBeenCalled();
    expect(await refundRow(`subscription:${addon.id}`)).toBeNull();
  });

  it("an add-on order paid for a deleted team is held for review", async () => {
    const goneTeamId = crypto.randomUUID();
    const orderId = `order_gone_${ts}`;
    targets.push(`order:${orderId}`);

    await deliver("order.paid", {
      id: orderId,
      customer_id: "cus_gone",
      customer: { external_id: `team:${goneTeamId}`, metadata: { teamId: goneTeamId } },
      product_id: "prod_blocks_test",
      units: 1,
      total_amount: 900,
      status: "paid",
    });

    expect(await refundRow(`order:${orderId}`)).toMatchObject({
      reason: "deleted_account",
      team_id: goneTeamId,
      status: "held",
    });
  });
});
