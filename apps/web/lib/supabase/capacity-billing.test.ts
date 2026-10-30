import { beforeEach, describe, expect, it, vi } from "vitest";

const PRODUCTS = vi.hoisted(() => ({
  oneTime: "prod_one_time",
  monthly: "prod_monthly",
  monthlyAdd: "prod_monthly_add",
  overage: "prod_overage",
}));

const DOMAIN_PRODUCTS = vi.hoisted(() => ({
  monthly: "prod_domains",
  monthlyAdd: "prod_domains_add",
}));

const mockFns = vi.hoisted(() => ({
  rpc: vi.fn(),
  checkoutsCreate: vi.fn(),
  subscriptionsUpdate: vi.fn(),
  subscriptionsRevoke: vi.fn(),
  subscriptionsGet: vi.fn(),
  reportError: vi.fn(),
}));

// Rows the fake database answers with, per table.
const tables: {
  users: Record<string, unknown> | null;
  capacity_subscriptions: Record<string, unknown>[];
} = { users: null, capacity_subscriptions: [] };
const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];

function query(table: string) {
  let patch: Record<string, unknown> | null = null;
  const builder = {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    is: () => builder,
    update: (value: Record<string, unknown>) => {
      patch = value;
      updates.push({ table, patch: value });
      return builder;
    },
    maybeSingle: async () => ({
      data:
        table === "users"
          ? tables.users
          : table === "capacity_subscriptions"
            ? (tables.capacity_subscriptions[0] ?? null)
            : null,
      error: null,
    }),
    then: (resolve: (value: unknown) => void) =>
      resolve(
        patch
          ? { data: null, error: null }
          : {
              data: table === "capacity_subscriptions" ? tables.capacity_subscriptions : [],
              error: null,
            }
      ),
  };
  return builder;
}

vi.mock("./admin", () => ({
  createAdminClient: () => ({ from: query, rpc: mockFns.rpc }),
}));
vi.mock("@/lib/polar", () => ({
  createPolarClient: () => ({
    checkouts: { create: mockFns.checkoutsCreate },
    subscriptions: {
      update: mockFns.subscriptionsUpdate,
      revoke: mockFns.subscriptionsRevoke,
      get: mockFns.subscriptionsGet,
    },
  }),
  getCapacityProductIds: () => PRODUCTS,
  configuredCapacityProductIds: () => PRODUCTS,
  getPageProductIds: () => null,
  configuredPageProductIds: () => ({}),
  getDomainProductIds: () => DOMAIN_PRODUCTS,
  configuredDomainProductIds: () => DOMAIN_PRODUCTS,
  teamBusinessProductId: () => null,
  loggablePolarError: (error: unknown) => error,
  isEndedSubscriptionError: (error: unknown) =>
    (error as { code?: string } | null)?.code === "AlreadyCanceledSubscription",
}));
vi.mock("@/lib/env", () => ({
  publicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));
vi.mock("@/lib/observability", () => ({ reportError: mockFns.reportError }));
vi.mock("./billing", () => ({
  ensurePolarCustomerId: async () => "cus_user",
  getBillingUser: async () => ({ id: "user_1" }),
}));
vi.mock("./team-billing", () => ({
  ensureTeamPolarCustomerId: async () => "cus_team",
  getTeamForOwner: async () => ({ id: "team_1" }),
}));

import {
  addonStatus,
  applyCapacityWebhookEvent,
  changeMonthlyBlocks,
  reconcileAddonsWithPlan,
} from "./capacity-billing";

const USER = { kind: "user" as const, userId: "user_1" };

function proAccount(overrides: Record<string, unknown> = {}) {
  return {
    plan: "pro",
    subscription_status: "active",
    cancel_at_period_end: false,
    polar_customer_id: "cus_user",
    requests_used: 0,
    request_limit: 100_000,
    block_requests: 0,
    credit_requests: 0,
    overage_active: false,
    overage_max: 0,
    overage_used: 0,
    overage_period_start: null,
    period_start: "2026-10-15T00:00:00Z",
    period_end: "2026-11-15T00:00:00Z",
    ...overrides,
  };
}

function blocksRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row_blocks",
    kind: "blocks",
    polar_subscription_id: "sub_blocks",
    status: "active",
    units: 2,
    pending_units: null,
    cancel_at_period_end: false,
    canceled_with_plan: false,
    period_end: "2026-11-15T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  tables.users = proAccount();
  tables.capacity_subscriptions = [];
  mockFns.checkoutsCreate.mockResolvedValue({ url: "https://polar.test/checkout" });
  mockFns.subscriptionsUpdate.mockResolvedValue({});
  mockFns.subscriptionsRevoke.mockResolvedValue({});
  mockFns.rpc.mockResolvedValue({ data: { status: "ok" }, error: null });
  // Polar's own view of the blocks subscription: 2 units, nothing scheduled.
  mockFns.subscriptionsGet.mockResolvedValue({ id: "sub_blocks", units: 2, pending_update: null });
});

describe("addonStatus", () => {
  it("maps Polar's subscription state onto an add-on row", () => {
    expect(addonStatus({ status: "active" })).toBe("active");
    expect(addonStatus({ status: "active", cancel_at_period_end: true })).toBe("canceled");
    expect(addonStatus({ status: "past_due" })).toBe("past_due");
    expect(addonStatus({ status: "unpaid" })).toBe("past_due");
    expect(addonStatus({ status: "canceled", ended_at: "2026-10-27T00:00:00Z" })).toBeNull();
    expect(addonStatus({ status: "active", ended_at: "2026-10-27T00:00:00Z" })).toBeNull();
  });
});

describe("changeMonthlyBlocks", () => {
  it("starts recurring blocks with a checkout for the monthly product", async () => {
    await expect(changeMonthlyBlocks(USER, "user_1", 3)).resolves.toEqual({
      kind: "checkout",
      url: "https://polar.test/checkout",
    });
    expect(mockFns.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ products: ["prod_monthly"], units: 3, customer_id: "cus_user" })
    );
  });

  it("starts extra domains with a checkout for the domain product, marked as domains", async () => {
    tables.users = proAccount({
      plan: "business",
      pending_plan: null,
      billing_interval: "month",
      billing_period_end: null,
    });
    await changeMonthlyBlocks(USER, "user_1", 2, "domains");
    expect(mockFns.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        products: ["prod_domains"],
        units: 2,
        metadata: expect.objectContaining({ resource: "domains" }),
      })
    );
  });

  it("charges only the added domains, with the domain increase product", async () => {
    tables.users = proAccount({
      plan: "business",
      pending_plan: null,
      billing_interval: "month",
      billing_period_end: null,
    });
    tables.capacity_subscriptions = [
      blocksRow({
        id: "row_domains",
        kind: "domain_blocks",
        polar_subscription_id: "sub_domains",
        units: 1,
      }),
    ];
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_domains",
      units: 1,
      pending_update: null,
    });
    await changeMonthlyBlocks(USER, "user_1", 3, "domains");
    expect(mockFns.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        products: ["prod_domains_add"],
        units: 2,
        metadata: expect.objectContaining({ resource: "domains" }),
      })
    );
  });

  it("charges only the added blocks, at the full monthly price, for an increase", async () => {
    tables.capacity_subscriptions = [blocksRow()];
    await changeMonthlyBlocks(USER, "user_1", 5);
    expect(mockFns.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        products: ["prod_monthly_add"],
        units: 3,
        min_units: 3,
        max_units: 3,
      })
    );
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("schedules a decrease for the renewal without charging", async () => {
    tables.capacity_subscriptions = [blocksRow()];
    await expect(changeMonthlyBlocks(USER, "user_1", 1)).resolves.toEqual({
      kind: "scheduled",
      units: 1,
    });
    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      units: 1,
      proration_behavior: "next_period",
    });
    expect(mockFns.checkoutsCreate).not.toHaveBeenCalled();
  });

  it("ends the blocks at the renewal for zero", async () => {
    tables.capacity_subscriptions = [blocksRow()];
    await changeMonthlyBlocks(USER, "user_1", 0);
    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      cancel_at_period_end: true,
    });
  });

  it("refuses to start or keep blocks while the plan is set to end", async () => {
    tables.users = proAccount({ cancel_at_period_end: true });
    await expect(changeMonthlyBlocks(USER, "user_1", 2)).rejects.toMatchObject({
      code: "plan_ending",
    });
    expect(mockFns.checkoutsCreate).not.toHaveBeenCalled();
  });

  it("leaves blocks set to end alone until an increase is paid for", async () => {
    tables.capacity_subscriptions = [blocksRow({ cancel_at_period_end: true })];
    await changeMonthlyBlocks(USER, "user_1", 4);
    expect(mockFns.checkoutsCreate).toHaveBeenCalled();
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("drops a scheduled reduction when Polar's own count is the one asked for", async () => {
    tables.capacity_subscriptions = [blocksRow({ pending_units: 1 })];
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_blocks",
      units: 2,
      pending_update: { units: 1 },
    });
    await changeMonthlyBlocks(USER, "user_1", 2);
    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      pending_update: null,
    });
  });

  it("schedules a paid increase again when Polar renews below it", async () => {
    // 2 blocks plus 1 paid mid-period; then a reduction to 2, which Polar
    // records as no change because 2 is its own count until the renewal.
    tables.capacity_subscriptions = [blocksRow({ units: 3, pending_units: 2 })];
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_blocks",
      units: 2,
      pending_update: null,
    });
    await changeMonthlyBlocks(USER, "user_1", 3);
    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      units: 3,
      proration_behavior: "next_period",
    });
  });

  it("changes nothing when Polar already renews at the count asked for", async () => {
    tables.capacity_subscriptions = [blocksRow({ units: 3, pending_units: 3 })];
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_blocks",
      units: 2,
      pending_update: { units: 3 },
    });
    await expect(changeMonthlyBlocks(USER, "user_1", 3)).resolves.toEqual({ kind: "unchanged" });
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("makes ending blocks the customer's own choice, even when the plan had set them to end", async () => {
    tables.capacity_subscriptions = [
      blocksRow({ cancel_at_period_end: true, canceled_with_plan: true }),
    ];
    await changeMonthlyBlocks(USER, "user_1", 0);
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
    expect(updates).toContainEqual({
      table: "capacity_subscriptions",
      patch: expect.objectContaining({ canceled_with_plan: false }),
    });
  });

  it("refuses more blocks without a live plan", async () => {
    tables.users = proAccount({ plan: "free", subscription_status: null });
    await expect(changeMonthlyBlocks(USER, "user_1", 1)).rejects.toMatchObject({
      code: "plan_required",
    });
  });
});

describe("applyCapacityWebhookEvent: a paid mid-period increase", () => {
  it("raises the renewal count in Polar once, from the next period", async () => {
    tables.capacity_subscriptions = [blocksRow({ units: 4 })];
    mockFns.rpc.mockResolvedValueOnce({
      data: {
        status: "ok",
        kind: "block_increase",
        subscription_id: "sub_blocks",
        target_units: 4,
        synced: false,
      },
      error: null,
    });

    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "requests", kind: "monthly_add" },
      {
        id: "ord_1",
        units: 2,
        total_amount: 400,
      }
    );

    expect(mockFns.rpc).toHaveBeenCalledWith("grant_capacity_purchase", {
      p_order_id: "ord_1",
      p_user_id: "user_1",
      p_team_id: null,
      p_kind: "block_increase",
      p_units: 2,
      p_amount: 400,
    });
    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      units: 4,
      proration_behavior: "next_period",
    });
    expect(updates.some((u) => u.table === "capacity_purchases" && "synced_at" in u.patch)).toBe(
      true
    );
  });

  it("keeps blocks the customer had set to end, since they just paid for more", async () => {
    tables.capacity_subscriptions = [blocksRow({ units: 4, cancel_at_period_end: true })];
    mockFns.rpc.mockResolvedValueOnce({
      data: { status: "ok", kind: "block_increase", subscription_id: "sub_blocks", synced: false },
      error: null,
    });
    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "requests", kind: "monthly_add" },
      { id: "ord_2", units: 1 }
    );
    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      cancel_at_period_end: false,
    });
  });

  it("does not let a paid increase keep blocks past a plan that is ending", async () => {
    tables.users = proAccount({ cancel_at_period_end: true });
    tables.capacity_subscriptions = [blocksRow({ units: 4, cancel_at_period_end: true })];
    mockFns.rpc.mockResolvedValueOnce({
      data: { status: "ok", kind: "block_increase", subscription_id: "sub_blocks", synced: false },
      error: null,
    });

    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "requests", kind: "monthly_add" },
      { id: "ord_4", units: 1 }
    );

    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalledWith("sub_blocks", {
      cancel_at_period_end: false,
    });
    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      units: 4,
      proration_behavior: "next_period",
    });
  });

  it("marks the order synced when the subscription has ended meanwhile", async () => {
    tables.capacity_subscriptions = [blocksRow({ units: 4 })];
    mockFns.rpc.mockResolvedValueOnce({
      data: { status: "ok", kind: "block_increase", subscription_id: "sub_blocks", synced: false },
      error: null,
    });
    mockFns.subscriptionsUpdate.mockRejectedValueOnce({ code: "AlreadyCanceledSubscription" });
    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "requests", kind: "monthly_add" },
      { id: "ord_3", units: 1 }
    );
    expect(updates.some((u) => u.table === "capacity_purchases" && "synced_at" in u.patch)).toBe(
      true
    );
  });

  it("leaves Polar alone for a repeated order that was already synced", async () => {
    mockFns.rpc.mockResolvedValueOnce({
      data: {
        status: "duplicate",
        kind: "block_increase",
        subscription_id: "sub_blocks",
        target_units: 4,
        synced: true,
      },
      error: null,
    });
    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "requests", kind: "monthly_add" },
      { id: "ord_1", units: 2 }
    );
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
  });
});

describe("applyCapacityWebhookEvent: subscriptions nobody should keep paying for", () => {
  it("ends a second blocks subscription and keeps what was paid as one-time blocks", async () => {
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_second",
      status: "active",
      units: 2,
      amount: 400,
      current_period_start: "2026-10-27T00:00:00Z",
      current_period_end: "2026-11-27T00:00:00Z",
    });
    mockFns.rpc.mockResolvedValueOnce({ data: { status: "duplicate" }, error: null });

    await applyCapacityWebhookEvent(
      "subscription.created",
      USER,
      { resource: "requests", kind: "monthly" },
      { id: "sub_second" }
    );

    expect(mockFns.subscriptionsRevoke).toHaveBeenCalledWith("sub_second");
    expect(mockFns.rpc).toHaveBeenCalledWith("grant_capacity_purchase", {
      p_order_id: "subscription:sub_second",
      p_user_id: "user_1",
      p_team_id: null,
      p_kind: "credits",
      p_units: 2,
      p_amount: 400,
    });
  });

  it("leaves a duplicate live when its blocks cannot be granted, so the redelivery tries again", async () => {
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_second",
      status: "active",
      units: 2,
      current_period_start: "2026-10-27T00:00:00Z",
      current_period_end: "2026-11-27T00:00:00Z",
    });
    mockFns.rpc
      .mockResolvedValueOnce({ data: { status: "duplicate" }, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("connection reset") });

    await expect(
      applyCapacityWebhookEvent(
        "subscription.created",
        USER,
        { resource: "requests", kind: "monthly" },
        { id: "sub_second" }
      )
    ).rejects.toThrow("connection reset");
    expect(mockFns.subscriptionsRevoke).not.toHaveBeenCalled();
  });

  it("ignores a subscription still waiting for its first payment", async () => {
    mockFns.subscriptionsGet.mockResolvedValue({ id: "sub_pending", status: "incomplete" });
    await applyCapacityWebhookEvent(
      "subscription.created",
      USER,
      { resource: "requests", kind: "monthly" },
      { id: "sub_pending" }
    );
    expect(mockFns.rpc).not.toHaveBeenCalled();
    expect(mockFns.subscriptionsRevoke).not.toHaveBeenCalled();
  });

  it("ends a subscription whose account is gone", async () => {
    mockFns.subscriptionsGet.mockResolvedValue({ id: "sub_orphan", status: "active" });
    mockFns.rpc.mockResolvedValueOnce({ data: { status: "no_account" }, error: null });

    await applyCapacityWebhookEvent(
      "subscription.created",
      USER,
      { resource: "requests", kind: "overage" },
      { id: "sub_orphan" }
    );

    expect(mockFns.subscriptionsRevoke).toHaveBeenCalledWith("sub_orphan");
  });

  it("ends a new add-on with a plan that is already set to end", async () => {
    tables.users = proAccount({ cancel_at_period_end: true });
    tables.capacity_subscriptions = [blocksRow()];
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_blocks",
      status: "active",
      units: 2,
      current_period_start: "2026-10-27T00:00:00Z",
      current_period_end: "2026-11-15T00:00:00Z",
    });

    await applyCapacityWebhookEvent(
      "subscription.created",
      USER,
      { resource: "requests", kind: "monthly" },
      { id: "sub_blocks" }
    );

    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      cancel_at_period_end: true,
    });
  });
});

describe("reconcileAddonsWithPlan", () => {
  const overageRow = {
    ...blocksRow(),
    id: "row_overage",
    kind: "overage",
    polar_subscription_id: "sub_overage",
    units: 0,
  };

  it("ends blocks now and overage at its period end when the plan is gone", async () => {
    tables.users = proAccount({ plan: "free", subscription_status: null });
    tables.capacity_subscriptions = [blocksRow(), overageRow];

    await reconcileAddonsWithPlan(USER);

    expect(mockFns.subscriptionsRevoke).toHaveBeenCalledWith("sub_blocks");
    // They were going to renew, so the paid period is kept as one-time blocks.
    expect(mockFns.rpc).toHaveBeenCalledWith(
      "grant_capacity_purchase",
      expect.objectContaining({
        p_order_id: "subscription:sub_blocks",
        p_kind: "credits",
        p_units: 2,
      })
    );
    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_overage", {
      cancel_at_period_end: true,
    });
    expect(mockFns.subscriptionsRevoke).not.toHaveBeenCalledWith("sub_overage");
    // Ended because the plan is gone, so a later plan does not revive it.
    expect(updates).toContainEqual({
      table: "capacity_subscriptions",
      patch: expect.objectContaining({ cancel_at_period_end: true, canceled_with_plan: false }),
    });
  });

  it("grants paid blocks before ending them, so a failed grant is retried", async () => {
    tables.users = proAccount({ plan: "free", subscription_status: null });
    tables.capacity_subscriptions = [blocksRow()];
    mockFns.rpc
      .mockResolvedValueOnce({ data: null, error: null }) // sync_capacity_account
      .mockResolvedValueOnce({ data: null, error: new Error("connection reset") });

    await expect(reconcileAddonsWithPlan(USER)).rejects.toThrow("connection reset");
    expect(mockFns.subscriptionsRevoke).not.toHaveBeenCalled();
  });

  it("credits nothing for blocks that were ending with the plan or behind on payment", async () => {
    tables.users = proAccount({ plan: "free", subscription_status: null });
    tables.capacity_subscriptions = [blocksRow({ cancel_at_period_end: true })];
    await reconcileAddonsWithPlan(USER);

    tables.capacity_subscriptions = [blocksRow({ status: "past_due" })];
    await reconcileAddonsWithPlan(USER);

    expect(mockFns.rpc).not.toHaveBeenCalledWith("grant_capacity_purchase", expect.anything());
    expect(mockFns.subscriptionsRevoke).toHaveBeenCalledTimes(2);
  });

  it("does not bring overage back with a later plan once the plan was gone", async () => {
    tables.users = proAccount({ plan: "free", subscription_status: null });
    tables.capacity_subscriptions = [
      { ...overageRow, cancel_at_period_end: true, canceled_with_plan: true },
    ];

    await reconcileAddonsWithPlan(USER);

    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
    expect(updates).toContainEqual({
      table: "capacity_subscriptions",
      patch: expect.objectContaining({ canceled_with_plan: false }),
    });
  });

  it("ends the add-ons with a plan that is set to end", async () => {
    tables.users = proAccount({ cancel_at_period_end: true });
    tables.capacity_subscriptions = [blocksRow()];

    await reconcileAddonsWithPlan(USER);

    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      cancel_at_period_end: true,
    });
    expect(updates).toContainEqual({
      table: "capacity_subscriptions",
      patch: expect.objectContaining({ canceled_with_plan: true }),
    });
  });

  it("brings back only the add-ons that were ending because of the plan", async () => {
    tables.capacity_subscriptions = [
      blocksRow({ cancel_at_period_end: true, canceled_with_plan: true }),
      { ...overageRow, cancel_at_period_end: true, canceled_with_plan: false },
    ];

    await reconcileAddonsWithPlan(USER);

    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledTimes(1);
    expect(mockFns.subscriptionsUpdate).toHaveBeenCalledWith("sub_blocks", {
      cancel_at_period_end: false,
    });
  });

  it("records an add-on Polar has already ended instead of failing the webhook", async () => {
    tables.users = proAccount({ cancel_at_period_end: true });
    tables.capacity_subscriptions = [blocksRow()];
    mockFns.subscriptionsUpdate.mockRejectedValueOnce({ code: "AlreadyCanceledSubscription" });

    await expect(reconcileAddonsWithPlan(USER)).resolves.toBeUndefined();
    expect(mockFns.rpc).toHaveBeenCalledWith(
      "apply_capacity_subscription",
      expect.objectContaining({ p_subscription_id: "sub_blocks", p_status: null })
    );
  });

  it("does nothing in Polar when plan and add-ons agree", async () => {
    tables.capacity_subscriptions = [blocksRow()];
    await reconcileAddonsWithPlan(USER);
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockFns.subscriptionsRevoke).not.toHaveBeenCalled();
  });
});
