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
  recordRefund: vi.fn(),
  checkoutLinkOverageMax: vi.fn(),
  supersedeCheckoutLinks: vi.fn(),
  markCheckoutLinkMismatch: vi.fn(),
}));

// The customer the event names, which a link named by its metadata must have.
const CUSTOMER_OF_EVENT = null;

vi.mock("@/lib/billing/refunds", () => ({ recordRefund: mockFns.recordRefund }));
vi.mock("@/lib/billing/checkout-link-rows", () => ({
  checkoutLinkOverageMax: mockFns.checkoutLinkOverageMax,
  supersedeCheckoutLinks: mockFns.supersedeCheckoutLinks,
  markCheckoutLinkMismatch: mockFns.markCheckoutLinkMismatch,
}));

// Rows the fake database answers with, per table.
const tables: {
  users: Record<string, unknown> | null;
  teams?: Record<string, unknown> | null;
  capacity_subscriptions: Record<string, unknown>[];
  capacity_purchases?: Record<string, unknown> | null;
} = { users: null, capacity_subscriptions: [] };
const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
/** The eq filters of each update, by its index in `updates`. */
const updateFilters: Array<Array<[string, unknown]>> = [];

function query(table: string) {
  let patch: Record<string, unknown> | null = null;
  let filters: Array<[string, unknown]> | null = null;
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters?.push([column, value]);
      return builder;
    },
    not: () => builder,
    is: () => builder,
    limit: () => builder,
    update: (value: Record<string, unknown>) => {
      patch = value;
      updates.push({ table, patch: value });
      filters = [];
      updateFilters[updates.length - 1] = filters;
      return builder;
    },
    maybeSingle: async () => ({
      data:
        table === "users"
          ? tables.users
          : table === "teams"
            ? (tables.teams ?? null)
            : table === "capacity_subscriptions"
              ? (tables.capacity_subscriptions[0] ?? null)
              : table === "capacity_purchases"
                ? (tables.capacity_purchases ?? null)
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
  createOneTimeBlocksCheckout,
  getCapacityState,
  monthlyBlocksPurchase,
  oneTimeBlocksPurchase,
  overagePurchase,
  reconcileAddonsWithPlan,
  setOverage,
} from "./capacity-billing";
import { withPolarMutationGuard } from "@/lib/billing/polar-guard";

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
  updateFilters.length = 0;
  tables.capacity_purchases = null;
  tables.teams = null;
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

  it("pins an approval's checkouts to the approved count; a session's stays adjustable", async () => {
    await changeMonthlyBlocks(USER, "user_1", 3, "requests", { exactUnits: true });
    expect(mockFns.checkoutsCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ units: 3, min_units: 3, max_units: 3 })
    );
    await createOneTimeBlocksCheckout(USER, "user_1", 4, "requests", { exactUnits: true });
    expect(mockFns.checkoutsCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ products: ["prod_one_time"], units: 4, min_units: 4, max_units: 4 })
    );
    await createOneTimeBlocksCheckout(USER, "user_1", 4);
    expect(mockFns.checkoutsCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ units: 4, min_units: 1, max_units: 400 })
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
        // The count it adds to, so a payment on another count is told apart.
        metadata: expect.objectContaining({ base_units: 2 }),
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

  it("ends or cuts blocks whose products are no longer offered", async () => {
    // The page products are unset in this suite.
    tables.capacity_subscriptions = [blocksRow({ kind: "page_blocks" })];
    await expect(changeMonthlyBlocks(USER, "user_1", 0, "pages")).resolves.toEqual({
      kind: "scheduled",
      units: 0,
    });
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

  it("reads a free plan as one to upgrade, not one held without a subscription", async () => {
    tables.users = proAccount({ plan: "free", subscription_status: null });
    await expect(getCapacityState(USER)).resolves.toMatchObject({
      eligible: false,
      noSubscription: false,
    });
  });
});

describe("complimentary (staff) teams", () => {
  const TEAM = { kind: "team" as const, teamId: "team_1" };
  const message = "This team is complimentary (staff) and has no subscription to add to";

  beforeEach(() => {
    tables.teams = {
      ...proAccount({ polar_customer_id: null }),
      subscription_status: "active",
      polar_subscription_id: null,
      business: true,
      seats: 10,
      pending_plan: null,
      billing_interval: "month",
      billing_period_end: null,
      credit_pages: 0,
      page_block_pages: 0,
      page_overage_active: false,
      page_overage_max: 0,
      extra_domains: 0,
    };
  });

  it("refuses add-ons before Polar is asked", async () => {
    await expect(changeMonthlyBlocks(TEAM, "user_1", 1)).rejects.toMatchObject({
      code: "plan_required",
      message,
    });
    await expect(createOneTimeBlocksCheckout(TEAM, "user_1", 1)).rejects.toMatchObject({
      code: "plan_required",
      message,
    });
    expect(mockFns.checkoutsCreate).not.toHaveBeenCalled();
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("does not offer them, and says the plan has no subscription", async () => {
    await expect(getCapacityState(TEAM)).resolves.toMatchObject({
      eligible: false,
      noSubscription: true,
    });
  });

  it("ends add-ons left from a paid plan, as when the plan is gone", async () => {
    // A staff team whose Polar plan was revoked is live again with no
    // subscription: its add-ons have no plan to renew with.
    tables.capacity_subscriptions = [blocksRow({ user_id: null, team_id: "team_1" })];

    await reconcileAddonsWithPlan(TEAM);

    expect(mockFns.subscriptionsRevoke).toHaveBeenCalledWith("sub_blocks");
  });
});

describe("setOverage: the maximum and the Polar call go together", () => {
  function overageRow(overrides: Record<string, unknown> = {}) {
    return blocksRow({
      id: "row_overage",
      kind: "overage",
      polar_subscription_id: "sub_overage",
      units: null,
      ...overrides,
    });
  }
  const maxWrites = () =>
    updates.filter((u) => u.table === "users" && "overage_max" in u.patch).map((u) => u.patch);

  it("checks an approval's guard before writing the maximum, so a refusal changed nothing", async () => {
    tables.users = proAccount({ overage_max: 50_000 });
    tables.capacity_subscriptions = [overageRow()];
    const refused = new Error("Nothing was changed: its lease ran out");
    const guard = { beforeMutation: vi.fn().mockRejectedValue(refused) };
    await expect(
      withPolarMutationGuard(guard, () => setOverage(USER, "user_1", { enabled: false }))
    ).rejects.toBe(refused);
    expect(guard.beforeMutation).toHaveBeenCalledWith("overage.max");
    expect(maxWrites()).toEqual([]);
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();

    await expect(
      withPolarMutationGuard(guard, () =>
        setOverage(USER, "user_1", { enabled: true, maxRequests: 100_000 })
      )
    ).rejects.toBe(refused);
    expect(maxWrites()).toEqual([]);
  });

  it("puts the previous maximum back when Polar refuses to end overage", async () => {
    tables.users = proAccount({ overage_max: 50_000 });
    tables.capacity_subscriptions = [overageRow()];
    mockFns.subscriptionsUpdate.mockRejectedValueOnce(
      Object.assign(new Error("Unprocessable"), { statusCode: 422 })
    );
    await expect(setOverage(USER, "user_1", { enabled: false })).rejects.toThrow("Unprocessable");
    expect(maxWrites()).toEqual([{ overage_max: 0 }, { overage_max: 50_000 }]);
    expect(updates.some((u) => u.table === "capacity_subscriptions")).toBe(false);
  });

  it("keeps overage at 0 when ending it may have gone through (a timeout)", async () => {
    tables.users = proAccount({ overage_max: 50_000 });
    tables.capacity_subscriptions = [overageRow()];
    mockFns.subscriptionsUpdate.mockRejectedValueOnce(new Error("The operation timed out"));
    await expect(setOverage(USER, "user_1", { enabled: false })).rejects.toThrow("timed out");
    expect(maxWrites()).toEqual([{ overage_max: 0 }]);
  });

  it("puts the previous maximum back when the overage checkout cannot be made", async () => {
    tables.users = proAccount({ overage_max: 25_000 });
    mockFns.checkoutsCreate.mockRejectedValueOnce(new Error("Polar is down"));
    await expect(
      setOverage(USER, "user_1", { enabled: true, maxRequests: 100_000 })
    ).rejects.toThrow("Polar is down");
    expect(maxWrites()).toEqual([{ overage_max: 100_000 }, { overage_max: 25_000 }]);
  });

  it("keeps the new maximum when Polar takes the change", async () => {
    tables.users = proAccount({ overage_max: 25_000 });
    await expect(
      setOverage(USER, "user_1", { enabled: true, maxRequests: 100_000 })
    ).resolves.toEqual({ kind: "checkout", url: "https://polar.test/checkout" });
    expect(maxWrites()).toEqual([{ overage_max: 100_000 }]);
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
    mockFns.subscriptionsGet.mockResolvedValueOnce({
      status: "canceled",
      ended_at: "2026-10-30T00:00:00Z",
    });
    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "requests", kind: "monthly_add" },
      { id: "ord_3", units: 1 }
    );
    expect(updates.some((u) => u.table === "capacity_purchases" && "synced_at" in u.patch)).toBe(
      true
    );
    // Ended: the row ends too.
    expect(mockFns.rpc).toHaveBeenCalledWith(
      "apply_capacity_subscription",
      expect.objectContaining({ p_subscription_id: "sub_blocks", p_status: null })
    );
  });

  it("keeps the raised units of one Polar has only set to end", async () => {
    tables.capacity_subscriptions = [blocksRow({ units: 4 })];
    mockFns.rpc.mockResolvedValueOnce({
      data: { status: "ok", kind: "block_increase", subscription_id: "sub_blocks", synced: false },
      error: null,
    });
    // Polar answers the same code for one that will end at its period end.
    mockFns.subscriptionsUpdate.mockRejectedValueOnce({ code: "AlreadyCanceledSubscription" });
    mockFns.subscriptionsGet.mockResolvedValueOnce({
      status: "active",
      cancel_at_period_end: true,
      ended_at: null,
    });
    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "requests", kind: "monthly_add" },
      { id: "ord_4", units: 1 }
    );
    // Neither ended nor granted again as one-time blocks: the units count
    // until the period end.
    expect(mockFns.rpc).not.toHaveBeenCalledWith(
      "apply_capacity_subscription",
      expect.objectContaining({ p_status: null })
    );
    expect(mockFns.rpc).not.toHaveBeenCalledWith(
      "grant_capacity_purchase",
      expect.objectContaining({ p_order_id: "increase:ord_4" })
    );
    expect(
      updates.some(
        (u) => u.table === "capacity_subscriptions" && u.patch.cancel_at_period_end === true
      )
    ).toBe(true);
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
      checkout_id: "co_second",
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
    // A checkout link whose session made it reads superseded, before the
    // revoke: a redelivery after it never comes back here.
    expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalledWith(
      "co_second",
      undefined,
      CUSTOMER_OF_EVENT
    );
    expect(mockFns.supersedeCheckoutLinks.mock.invocationCallOrder[0]).toBeLessThan(
      mockFns.subscriptionsRevoke.mock.invocationCallOrder[0]
    );
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
    expect(mockFns.recordRefund.mock.invocationCallOrder[0]).toBeLessThan(
      mockFns.subscriptionsRevoke.mock.invocationCallOrder[0]
    );
    expect(mockFns.recordRefund).toHaveBeenCalledWith({
      target: { subscription: "sub_orphan" },
      reason: "deleted_account",
      userId: "user_1",
      teamId: null,
    });
  });

  it("records nothing for the late end of an add-on the account deletion revoked", async () => {
    // Deleting an account revokes its add-ons, then the rows go: their
    // revoke and update events arrive for an account that is gone.
    mockFns.rpc.mockResolvedValue({ data: { status: "no_account" }, error: null });
    await applyCapacityWebhookEvent(
      "subscription.revoked",
      USER,
      { resource: "requests", kind: "monthly" },
      { id: "sub_gone", status: "canceled", ended_at: "2026-11-03T10:00:00Z" }
    );
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_gone",
      status: "canceled",
      ended_at: "2026-11-03T10:00:00Z",
    });
    await applyCapacityWebhookEvent(
      "subscription.updated",
      USER,
      { resource: "requests", kind: "monthly" },
      { id: "sub_gone" }
    );

    expect(mockFns.recordRefund).not.toHaveBeenCalled();
    expect(mockFns.subscriptionsRevoke).not.toHaveBeenCalled();
  });

  it("ends a second extra-domains subscription and records its refund", async () => {
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_domains_2",
      status: "active",
      units: 2,
      checkout_id: "co_domains_2",
    });
    mockFns.rpc.mockResolvedValueOnce({ data: { status: "duplicate" }, error: null });

    await applyCapacityWebhookEvent(
      "subscription.created",
      USER,
      { resource: "domains", kind: "monthly" },
      { id: "sub_domains_2" }
    );

    expect(mockFns.recordRefund).toHaveBeenCalledWith({
      target: { subscription: "sub_domains_2" },
      reason: "duplicate_addon",
      userId: "user_1",
      teamId: null,
    });
    expect(mockFns.subscriptionsRevoke).toHaveBeenCalledWith("sub_domains_2");
    // Recorded before the revoke, so a failure is retried with the webhook.
    expect(mockFns.recordRefund.mock.invocationCallOrder[0]).toBeLessThan(
      mockFns.subscriptionsRevoke.mock.invocationCallOrder[0]
    );
    expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalledWith(
      "co_domains_2",
      undefined,
      CUSTOMER_OF_EVENT
    );
    expect(mockFns.supersedeCheckoutLinks.mock.invocationCallOrder[0]).toBeLessThan(
      mockFns.subscriptionsRevoke.mock.invocationCallOrder[0]
    );
  });

  it("records a refund for a paid order whose account is gone", async () => {
    mockFns.rpc.mockResolvedValueOnce({ data: { status: "no_account" }, error: null });

    await applyCapacityWebhookEvent(
      "order.paid",
      { kind: "team", teamId: "team_gone" },
      { resource: "requests", kind: "one_time" },
      { id: "order_1", units: 2, total_amount: 1800 }
    );

    expect(mockFns.recordRefund).toHaveBeenCalledWith({
      target: { order: "order_1" },
      reason: "deleted_account",
      userId: null,
      teamId: "team_gone",
    });
  });

  it("records the refund again when the order for unapplied domains is delivered again", async () => {
    // The first delivery recorded the purchase, then failed to record the refund.
    mockFns.rpc.mockResolvedValueOnce({
      data: { status: "duplicate", kind: "domain_increase", subscription_id: null, synced: false },
      error: null,
    });

    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "domains", kind: "monthly_add" },
      { id: "order_domains", units: 1, total_amount: 300, checkout_id: "co_domains" }
    );

    expect(mockFns.recordRefund).toHaveBeenCalledWith({
      target: { order: "order_domains" },
      reason: "addon_not_applied",
      userId: "user_1",
      teamId: null,
    });
    expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalledWith(
      "co_domains",
      undefined,
      CUSTOMER_OF_EVENT
    );
  });

  it("records nothing for a deleted account's add-on Polar has ended since its first read", async () => {
    mockFns.rpc.mockResolvedValue({ data: { status: "no_account" }, error: null });
    mockFns.subscriptionsGet
      .mockResolvedValueOnce({ id: "sub_race", status: "active" })
      .mockResolvedValueOnce({
        id: "sub_race",
        status: "canceled",
        ended_at: "2026-11-03T10:00:00Z",
      });

    await applyCapacityWebhookEvent(
      "subscription.updated",
      USER,
      { resource: "requests", kind: "monthly" },
      { id: "sub_race" }
    );

    expect(mockFns.recordRefund).not.toHaveBeenCalled();
    expect(mockFns.subscriptionsRevoke).not.toHaveBeenCalled();
  });

  it("supersedes the link of domains whose subscription ended before they could ride on it", async () => {
    tables.capacity_subscriptions = [];
    tables.capacity_purchases = { kind: "domain_increase", units: 1, polar_subscription_id: null };
    mockFns.rpc.mockResolvedValueOnce({
      data: {
        status: "ok",
        kind: "domain_increase",
        subscription_id: "sub_domains",
        synced: false,
      },
      error: null,
    });
    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "domains", kind: "monthly_add" },
      {
        id: "order_domains",
        units: 1,
        total_amount: 300,
        checkout_id: "co_domains",
        metadata: { checkout_link: "link_1" },
      }
    );
    expect(mockFns.recordRefund).toHaveBeenCalledWith({
      target: { order: "order_domains" },
      reason: "addon_ended",
      userId: "user_1",
      teamId: null,
    });
    expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalledWith(
      "co_domains",
      { checkout_link: "link_1" },
      CUSTOMER_OF_EVENT
    );
    expect(mockFns.recordRefund.mock.invocationCallOrder[0]).toBeLessThan(
      mockFns.supersedeCheckoutLinks.mock.invocationCallOrder[0]
    );
    tables.capacity_purchases = null;
  });

  it("records a refund for paid domains with no subscription left to add them to", async () => {
    mockFns.rpc.mockResolvedValueOnce({
      data: { status: "ok", kind: "domain_increase", unapplied: true, synced: true },
      error: null,
    });

    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "domains", kind: "monthly_add" },
      { id: "order_domains", units: 1, total_amount: 300, checkout_id: "co_domains" }
    );

    expect(mockFns.recordRefund).toHaveBeenCalledWith({
      target: { order: "order_domains" },
      reason: "addon_not_applied",
      userId: "user_1",
      teamId: null,
    });
    // The link that bought them reads superseded, never paid.
    expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalledWith(
      "co_domains",
      undefined,
      CUSTOMER_OF_EVENT
    );
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("tells a person, and the link, when a top-up was paid on another count than it was made for", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Made when the account had 2 blocks; 3 more were added meanwhile, so
    // these 2 now make 7, not 4.
    mockFns.rpc.mockResolvedValueOnce({
      data: {
        status: "duplicate",
        kind: "block_increase",
        subscription_id: "sub_blocks",
        target_units: 7,
        synced: true,
      },
      error: null,
    });
    await applyCapacityWebhookEvent(
      "order.paid",
      USER,
      { resource: "requests", kind: "monthly_add" },
      { id: "ord_base", units: 2, checkout_id: "co_base", metadata: { base_units: "2" } }
    );
    expect(mockFns.markCheckoutLinkMismatch).toHaveBeenCalledWith("co_base", "base");

    // On the count it was made for: nothing to say.
    mockFns.markCheckoutLinkMismatch.mockClear();
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
      { id: "ord_base", units: 2, checkout_id: "co_base", metadata: { base_units: 2 } }
    );
    expect(mockFns.markCheckoutLinkMismatch).not.toHaveBeenCalled();
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

describe("applyCapacityWebhookEvent: an add-on's renewal moves onto the plan's", () => {
  async function renewAddon(now: string, planEnd: string, addonEnd: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    try {
      tables.users = proAccount({ period_end: planEnd });
      tables.capacity_subscriptions = [blocksRow({ period_end: addonEnd })];
      mockFns.subscriptionsGet.mockResolvedValue({
        id: "sub_blocks",
        status: "active",
        units: 2,
        current_period_end: addonEnd,
      });
      await applyCapacityWebhookEvent(
        "subscription.updated",
        USER,
        { resource: "requests", kind: "monthly" },
        { id: "sub_blocks" }
      );
    } finally {
      vi.useRealTimers();
    }
    return mockFns.subscriptionsUpdate.mock.calls
      .filter(([, body]) => "current_billing_period_end" in (body as object))
      .map(
        ([, body]) => (body as { current_billing_period_end: string }).current_billing_period_end
      );
  }

  it("moves a later add-on back to the plan's renewal", async () => {
    expect(
      await renewAddon("2026-11-01T00:00:00Z", "2026-11-15T00:00:00Z", "2026-11-27T00:00:00Z")
    ).toEqual(["2026-11-15T00:00:00.000Z"]);
  });

  it("gives back the days a short month took, once, so it keeps the plan's day", async () => {
    // Aligned with a window that ended Feb 28, Polar renews it on the 28th
    // while the plan's window runs to the 31st.
    expect(
      await renewAddon("2027-03-01T00:00:00Z", "2027-03-31T10:00:00Z", "2027-03-28T10:00:00Z")
    ).toEqual(["2027-03-31T10:00:00.000Z"]);
    // The stored end moves with it, so the sweep never reads it as overdue.
    expect(
      updates.some(
        (update) =>
          update.table === "capacity_subscriptions" &&
          update.patch.period_end === "2027-03-31T10:00:00.000Z"
      )
    ).toBe(true);
  });

  it("never moves an add-on later by more than a short month took", async () => {
    // The plan renewed and the add-on's own renewal is not in yet.
    expect(
      await renewAddon("2027-03-30T00:00:00Z", "2027-04-30T10:00:00Z", "2027-03-31T10:00:00Z")
    ).toEqual([]);
    // Days apart, but across a month's end.
    expect(
      await renewAddon("2027-03-01T00:00:00Z", "2027-04-01T10:00:00Z", "2027-03-30T10:00:00Z")
    ).toEqual([]);
    // Four days in the same month is not a short month.
    expect(
      await renewAddon("2027-03-01T00:00:00Z", "2027-03-31T10:00:00Z", "2027-03-27T10:00:00Z")
    ).toEqual([]);
  });

  it("leaves an add-on alone once its period is over", async () => {
    expect(
      await renewAddon("2027-03-28T10:00:30Z", "2027-03-31T10:00:00Z", "2027-03-28T10:00:00Z")
    ).toEqual([]);
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
    mockFns.subscriptionsGet.mockResolvedValueOnce({
      status: "canceled",
      ended_at: "2026-10-30T00:00:00Z",
    });

    await expect(reconcileAddonsWithPlan(USER)).resolves.toBeUndefined();
    expect(mockFns.rpc).toHaveBeenCalledWith(
      "apply_capacity_subscription",
      expect.objectContaining({ p_subscription_id: "sub_blocks", p_status: null })
    );
  });

  it("records an add-on Polar has only set to end as ending, not ended", async () => {
    tables.users = proAccount({ cancel_at_period_end: true });
    tables.capacity_subscriptions = [blocksRow()];
    mockFns.subscriptionsUpdate.mockRejectedValueOnce({ code: "AlreadyCanceledSubscription" });
    mockFns.subscriptionsGet.mockResolvedValueOnce({
      status: "active",
      cancel_at_period_end: true,
      ended_at: null,
    });

    await reconcileAddonsWithPlan(USER);
    expect(mockFns.rpc).not.toHaveBeenCalledWith(
      "apply_capacity_subscription",
      expect.objectContaining({ p_status: null })
    );
    expect(
      updates.some(
        (u) => u.table === "capacity_subscriptions" && u.patch.cancel_at_period_end === true
      )
    ).toBe(true);
  });

  it("does nothing in Polar when plan and add-ons agree", async () => {
    tables.capacity_subscriptions = [blocksRow()];
    await reconcileAddonsWithPlan(USER);
    expect(mockFns.subscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockFns.subscriptionsRevoke).not.toHaveBeenCalled();
  });
});

describe("checkout link purchases", () => {
  const LINK = { id: "link_1", successUrl: "https://mailhooks.cc/checkout/complete" };

  it("checks one-time blocks without Polar, then sells exactly that many, naming the link", async () => {
    const purchase = await oneTimeBlocksPurchase(USER, "user_1", 3);
    expect(purchase.expected).toEqual({ product: "prod_one_time", units: 3 });
    expect(mockFns.checkoutsCreate).not.toHaveBeenCalled();

    await purchase.mint(LINK);
    expect(mockFns.checkoutsCreate).toHaveBeenCalledWith({
      products: ["prod_one_time"],
      units: 3,
      min_units: 3,
      max_units: 3,
      customer_id: "cus_user",
      success_url: "https://mailhooks.cc/checkout/complete",
      metadata: { capacity: "one_time", resource: "requests", checkout_link: "link_1" },
    });
  });

  it("leaves the dashboard's one-time checkout free to change the number", async () => {
    await createOneTimeBlocksCheckout(USER, "user_1", 3);
    expect(mockFns.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ units: 3, min_units: 1, max_units: 400 })
    );
    expect(mockFns.checkoutsCreate.mock.calls[0][0].metadata).not.toHaveProperty("checkout_link");
  });

  it("refuses someone else's account", async () => {
    await expect(oneTimeBlocksPurchase(USER, "user_2", 1)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("sells new monthly blocks in exactly the number asked, or only the added ones", async () => {
    const fresh = await monthlyBlocksPurchase(USER, "user_1", 4);
    expect(fresh.expected).toEqual({ product: "prod_monthly", units: 4 });
    await fresh.mint(LINK);
    expect(mockFns.checkoutsCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ products: ["prod_monthly"], units: 4, min_units: 4, max_units: 4 })
    );

    tables.capacity_subscriptions = [blocksRow()];
    const more = await monthlyBlocksPurchase(USER, "user_1", 5);
    expect(more.expected).toEqual({ product: "prod_monthly_add", units: 3 });
    await expect(monthlyBlocksPurchase(USER, "user_1", 2)).rejects.toMatchObject({
      code: "not_a_purchase",
    });
  });

  it("writes nothing for overage until its subscription arrives, and carries the maximum", async () => {
    const purchase = await overagePurchase(USER, "user_1");
    // The default, as nothing is stored.
    expect(purchase.max).toBe(125_000);
    await purchase.mint(LINK);
    expect(updates).toEqual([]);
    expect(mockFns.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        products: ["prod_overage"],
        metadata: {
          capacity: "overage",
          resource: "requests",
          overage_max: 125_000,
          checkout_link: "link_1",
        },
      })
    );

    // Opened later, it takes the maximum the account has stored now (the
    // person may have changed it since), and only else the link's own.
    tables.users = proAccount({ overage_max: 500_000 });
    const opened = await overagePurchase(USER, "user_1", "requests", 250_000);
    expect(opened.max).toBe(500_000);
    await opened.mint(LINK);
    expect(mockFns.checkoutsCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ overage_max: 500_000 }) })
    );
    tables.users = proAccount({ overage_max: 0 });
    expect((await overagePurchase(USER, "user_1", "requests", 250_000)).max).toBe(250_000);
  });

  it("gives the subscription the maximum its session was opened with, over the link's own", async () => {
    // Lowered after the link was made: the session carries the lower one.
    mockFns.checkoutLinkOverageMax.mockResolvedValue(500_000);
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_overage",
      status: "active",
      checkout_id: "co_link",
      metadata: { checkout_link: "link_1", overage_max: "100000" },
      current_period_start: "2026-10-27T00:00:00Z",
      current_period_end: "2026-11-27T00:00:00Z",
    });
    await applyCapacityWebhookEvent(
      "subscription.created",
      USER,
      { resource: "requests", kind: "overage" },
      { id: "sub_overage" }
    );
    expect(updates).toContainEqual({ table: "users", patch: { overage_max: 100_000 } });
    expect(updates).not.toContainEqual({ table: "users", patch: { overage_max: 500_000 } });
  });

  it("stores the link's overage maximum when its subscription first arrives", async () => {
    mockFns.checkoutLinkOverageMax.mockResolvedValue(250_000);
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_overage",
      status: "active",
      checkout_id: "co_link",
      current_period_start: "2026-10-27T00:00:00Z",
      current_period_end: "2026-11-27T00:00:00Z",
    });
    await applyCapacityWebhookEvent(
      "subscription.created",
      USER,
      { resource: "requests", kind: "overage" },
      { id: "sub_overage" }
    );
    expect(mockFns.checkoutLinkOverageMax).toHaveBeenCalledWith("co_link");
    expect(updates).toContainEqual({ table: "users", patch: { overage_max: 250_000 } });
  });

  it("stores it only over the maximum it read, so an owner's change meanwhile stays", async () => {
    mockFns.checkoutLinkOverageMax.mockResolvedValue(250_000);
    tables.users = proAccount({ overage_max: 40_000 });
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_overage",
      status: "active",
      checkout_id: "co_link",
      current_period_start: "2026-10-27T00:00:00Z",
      current_period_end: "2026-11-27T00:00:00Z",
    });
    await applyCapacityWebhookEvent(
      "subscription.created",
      USER,
      { resource: "requests", kind: "overage" },
      { id: "sub_overage" }
    );
    const at = updates.findIndex((u) => u.patch.overage_max === 250_000);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(updateFilters[at]).toContainEqual(["overage_max", 40_000]);
  });

  it("does not store it again once the subscription is known", async () => {
    mockFns.checkoutLinkOverageMax.mockResolvedValue(250_000);
    tables.capacity_subscriptions = [
      blocksRow({ id: "row_overage", kind: "overage", polar_subscription_id: "sub_overage" }),
    ];
    mockFns.subscriptionsGet.mockResolvedValue({
      id: "sub_overage",
      status: "active",
      checkout_id: "co_link",
      current_period_start: "2026-10-27T00:00:00Z",
      current_period_end: "2026-11-27T00:00:00Z",
    });
    await applyCapacityWebhookEvent(
      "subscription.updated",
      USER,
      { resource: "requests", kind: "overage" },
      { id: "sub_overage" }
    );
    expect(updates.filter((u) => "overage_max" in u.patch)).toEqual([]);
  });
});
