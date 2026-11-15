import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { POLAR_AUTO_REFUNDS: true, POLAR_AUTO_REFUND_MAX_CENTS: 30_000 },
  upserts: [] as Array<{ row: Record<string, unknown>; options: unknown }>,
  updates: [] as Array<{
    id: unknown;
    status: unknown;
    patch: Record<string, unknown>;
  }>,
  claimed: [] as Record<string, unknown>[],
  // Held rows flagged subscription_live that claimLiveRechecks finds due.
  rechecks: [] as Record<string, unknown>[],
  leases: [] as Array<{ ids: unknown; filters: Record<string, unknown> }>,
  orders: {} as Record<string, Record<string, unknown>>,
  refunds: [] as Record<string, unknown>[],
  ordersGet: vi.fn(),
  ordersList: vi.fn(),
  refundsList: vi.fn(),
  refundsCreate: vi.fn(),
  subscriptionsGet: vi.fn(),
  reportError: vi.fn(),
  auditSystemEvent: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ serverEnv: () => mocks.settings }));
vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }));
vi.mock("@/lib/audit", () => ({ auditSystemEvent: mocks.auditSystemEvent }));
vi.mock("@/lib/polar", () => ({
  createPolarClient: () => ({
    orders: { get: mocks.ordersGet, list: mocks.ordersList },
    refunds: { list: mocks.refundsList, create: mocks.refundsCreate },
    subscriptions: { get: mocks.subscriptionsGet },
  }),
  loggablePolarError: (error: unknown) => error,
  polarErrorCode: (error: unknown) => (error as { code?: string } | null)?.code ?? null,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      upsert: async (row: Record<string, unknown>, options: unknown) => {
        mocks.upserts.push({ row, options });
        return { error: null };
      },
      update: (patch: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        const builder = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return builder;
          },
          in: (column: string, value: unknown) => {
            filters[`in:${column}`] = value;
            return builder;
          },
          or: (value: unknown) => {
            filters.or = value;
            return builder;
          },
          select: () => builder,
          then: (resolve: (value: { data: unknown; error: null }) => void) => {
            if (filters["in:id"]) {
              // The lease of claimLiveRechecks: it answers the rows it took.
              mocks.leases.push({ ids: filters["in:id"], filters: { ...filters } });
              resolve({ data: mocks.rechecks, error: null });
              return;
            }
            mocks.updates.push({ id: filters.id, status: filters.status, patch });
            resolve({ data: null, error: null });
          },
        };
        return builder;
      },
      select: () => {
        const builder = {
          eq: () => builder,
          not: () => builder,
          lte: () => builder,
          or: () => builder,
          order: () => builder,
          limit: () => builder,
          then: (resolve: (value: { data: unknown; error: null }) => void) =>
            resolve({ data: mocks.rechecks.map((row) => ({ id: row.id })), error: null }),
        };
        return builder;
      },
    }),
    rpc: async () => ({ data: mocks.claimed, error: null }),
  }),
}));

import {
  claimLiveRechecks,
  hasSubscriptionEnded,
  isTransientPolarError,
  LIVE_RECHECK_MAX_MS,
  LIVE_SUBSCRIPTION_GRACE_MS,
  processRefund,
  recordRefund,
  REFUND_METADATA_KEY,
  runRefunds,
} from "./refunds";

const NOW = Date.parse("2026-11-03T12:00:00Z");

function order(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "paid",
    refundable_amount: 2900,
    refundable_tax_amount: 725,
    refunded_amount: 0,
    created_at: "2026-11-03T11:00:00Z",
    billing_reason: "subscription_create",
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "row_1",
    target: "order:ord_1",
    reason: "duplicate_plan",
    user_id: "user_1",
    team_id: null,
    status: "pending",
    hold_reason: null,
    orders: null,
    planned_cents: null,
    refunded_cents: 0,
    refund_ids: [],
    approved_at: null,
    attempts: 1,
    next_attempt_at: "2026-11-03T12:00:00Z",
    lease_until: "2026-11-03T12:05:00Z",
    last_error: null,
    created_at: "2026-11-03T11:30:00Z",
    updated_at: "2026-11-03T11:30:00Z",
    finished_at: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(overrides as any),
  };
}

const lastUpdate = () => mocks.updates[mocks.updates.length - 1]?.patch;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.settings.POLAR_AUTO_REFUNDS = true;
  mocks.settings.POLAR_AUTO_REFUND_MAX_CENTS = 30_000;
  mocks.upserts.length = 0;
  mocks.updates.length = 0;
  mocks.claimed.length = 0;
  mocks.rechecks.length = 0;
  mocks.leases.length = 0;
  mocks.orders = { ord_1: order("ord_1") };
  mocks.refunds = [];
  mocks.ordersGet.mockImplementation(async (id: string) => mocks.orders[id]);
  // A subscription target has normally been revoked by the time the worker looks.
  mocks.subscriptionsGet.mockImplementation(async (id: string) => ({
    id,
    status: "canceled",
    ended_at: "2026-11-03T11:30:01Z",
  }));
  mocks.ordersList.mockImplementation(async () => ({ items: Object.values(mocks.orders) }));
  mocks.refundsList.mockImplementation(async ({ order_id }: { order_id: string }) => ({
    items: mocks.refunds.filter((refund) => refund.order_id === order_id),
  }));
  mocks.refundsCreate.mockImplementation(async (body: Record<string, unknown>) => {
    const refund = {
      id: `ref_${mocks.refunds.length + 1}`,
      status: "succeeded",
      amount: body.amount,
      tax_amount: 725,
      order_id: body.order_id,
      metadata: body.metadata,
    };
    mocks.refunds.push(refund);
    return refund;
  });
});

describe("recordRefund", () => {
  it("queues a refund once per target, pending while automatic refunds are on", async () => {
    await recordRefund({
      target: { subscription: "sub_2" },
      reason: "duplicate_plan",
      userId: "user_1",
    });

    expect(mocks.upserts).toEqual([
      {
        row: {
          target: "subscription:sub_2",
          reason: "duplicate_plan",
          user_id: "user_1",
          team_id: null,
          status: "pending",
          hold_reason: null,
        },
        options: { onConflict: "target", ignoreDuplicates: true },
      },
    ]);
  });

  it("holds every refund for a person while automatic refunds are off", async () => {
    mocks.settings.POLAR_AUTO_REFUNDS = false;

    await recordRefund({ target: { order: "ord_1" }, reason: "deleted_account", teamId: "team_1" });

    expect(mocks.upserts[0].row).toMatchObject({
      target: "order:ord_1",
      user_id: null,
      team_id: "team_1",
      status: "held",
      hold_reason: "manual",
    });
  });
});

describe("processRefund", () => {
  it("refunds an order's whole refundable amount, marked with the row, and audits it", async () => {
    await expect(processRefund(row())).resolves.toBe("refunded");

    expect(mocks.refundsCreate).toHaveBeenCalledWith({
      order_id: "ord_1",
      reason: "duplicate",
      amount: 2900,
      comment: expect.stringContaining("second plan subscription"),
      metadata: { [REFUND_METADATA_KEY]: "row_1", reason: "duplicate_plan" },
    });
    expect(lastUpdate()).toMatchObject({
      status: "refunded",
      refunded_cents: 2900,
      refund_ids: ["ref_1"],
      planned_cents: 2900,
      lease_until: null,
    });
    // Every write is on the row as claimed, so a dismissal meanwhile wins.
    expect(
      mocks.updates.every((update) => update.id === "row_1" && update.status === "pending")
    ).toBe(true);
    // What it would refund is noted before refunding, keeping the lease.
    expect(mocks.updates[0].patch).toEqual({
      orders: [expect.objectContaining({ order_id: "ord_1", net: 2900 })],
      planned_cents: 2900,
      updated_at: expect.any(String),
    });
    expect(mocks.auditSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.refund_issued",
        targetId: "ord_1",
        userId: "user_1",
        metadata: expect.objectContaining({ amount_cents: 2900, refund_id: "ref_1" }),
      })
    );
  });

  it("does not refund twice: a refund made for the row before a crash is found and kept", async () => {
    mocks.orders.ord_1 = order("ord_1", {
      status: "refunded",
      refundable_amount: 0,
      refunded_amount: 2900,
    });
    mocks.refunds.push({
      id: "ref_earlier",
      status: "succeeded",
      amount: 2900,
      order_id: "ord_1",
      metadata: { [REFUND_METADATA_KEY]: "row_1" },
    });

    await expect(processRefund(row())).resolves.toBe("refunded");

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: "refunded", refund_ids: ["ref_earlier"] });
  });

  it("leaves an order someone else refunded alone", async () => {
    mocks.orders.ord_1 = order("ord_1", {
      status: "refunded",
      refundable_amount: 0,
      refunded_amount: 2900,
    });
    mocks.refunds.push({
      id: "ref_by_hand",
      status: "succeeded",
      amount: 2900,
      order_id: "ord_1",
      metadata: {},
    });

    await expect(processRefund(row())).resolves.toBe("nothing");

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: "nothing", refund_ids: [] });
  });

  it("refunds every paid order of a subscription and skips unpaid and empty ones", async () => {
    mocks.orders = {
      a: order("a"),
      b: order("b", { billing_reason: "subscription_update", refundable_amount: 500 }),
      c: order("c", { status: "void", refundable_amount: 0 }),
    };

    await expect(processRefund(row({ target: "subscription:sub_2" }))).resolves.toBe("refunded");

    expect(mocks.refundsCreate.mock.calls.map(([body]) => body.order_id)).toEqual(["a", "b"]);
    expect(lastUpdate()).toMatchObject({ refunded_cents: 3400 });
  });

  it("waits for an order that is not paid yet", async () => {
    mocks.orders.ord_1 = order("ord_1", { status: "pending" });

    await expect(processRefund(row())).resolves.toBe("waiting");

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ last_error: "not_paid_yet" });
    expect(Date.parse(String(lastUpdate()?.next_attempt_at))).toBeGreaterThan(NOW);
    expect(lastUpdate()).not.toHaveProperty("status");
  });

  it("holds a refund above the cap for a person", async () => {
    mocks.orders.ord_1 = order("ord_1", { refundable_amount: 35_000 });

    await expect(processRefund(row())).resolves.toBe("held");

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({
      status: "held",
      hold_reason: "over_cap",
      planned_cents: 35_000,
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      "[refunds] refund held for review",
      undefined,
      expect.objectContaining({ holdReason: "over_cap", plannedCents: 35_000 })
    );
  });

  it("holds a subscription with orders older than the window for a person", async () => {
    mocks.orders = {
      new: order("new"),
      old: order("old", {
        created_at: "2026-10-03T11:00:00Z",
        billing_reason: "subscription_cycle",
      }),
    };

    await expect(processRefund(row({ target: "subscription:sub_old" }))).resolves.toBe("held");

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: "held", hold_reason: "old_orders" });
  });

  it("prepares a held row for the review without refunding anything", async () => {
    await expect(
      processRefund(row({ status: "held", hold_reason: "manual", target: "subscription:sub_2" }))
    ).resolves.toBe("prepared");

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({
      planned_cents: 2900,
      orders: [
        {
          order_id: "ord_1",
          net: 2900,
          tax: 725,
          created_at: "2026-11-03T11:00:00Z",
          billing_reason: "subscription_create",
        },
      ],
    });
    expect(lastUpdate()).not.toHaveProperty("status");
    expect(mocks.reportError).toHaveBeenCalledWith(
      "[refunds] refund held for review",
      undefined,
      expect.objectContaining({ refundId: "row_1", holdReason: "manual", plannedCents: 2900 })
    );
  });

  it("closes a held row with nothing to refund", async () => {
    mocks.orders.ord_1 = order("ord_1", { status: "void", refundable_amount: 0 });

    await expect(processRefund(row({ status: "held", hold_reason: "manual" }))).resolves.toBe(
      "nothing"
    );
    expect(lastUpdate()).toMatchObject({ status: "nothing", planned_cents: 0 });
  });

  it("refunds an approved row past the cap and the window, but only the orders the person saw", async () => {
    mocks.orders = {
      seen: order("seen", { refundable_amount: 50_000, created_at: "2026-09-01T00:00:00Z" }),
      later: order("later", { billing_reason: "subscription_cycle" }),
    };

    await expect(
      processRefund(
        row({
          target: "subscription:sub_big",
          approved_at: "2026-11-03T11:59:00Z",
          orders: [{ order_id: "seen", net: 50_000 }],
          planned_cents: 50_000,
        })
      )
    ).resolves.toBe("refunded");

    expect(mocks.refundsCreate.mock.calls.map(([body]) => body.order_id)).toEqual(["seen"]);
    expect(lastUpdate()).toMatchObject({ status: "refunded", refunded_cents: 50_000 });
  });

  it("checks a refund Polar still has pending again later, then closes the row", async () => {
    mocks.refundsCreate.mockImplementationOnce(async (body: Record<string, unknown>) => {
      const refund = {
        id: "ref_slow",
        status: "pending",
        amount: body.amount,
        tax_amount: 725,
        order_id: body.order_id,
        metadata: body.metadata,
      };
      mocks.refunds.push(refund);
      return refund;
    });

    await expect(processRefund(row())).resolves.toBe("waiting");
    expect(lastUpdate()).toMatchObject({ last_error: "refund_pending" });
    expect(lastUpdate()).not.toHaveProperty("status");

    // Settled: the next pass records it and makes no second refund.
    mocks.refunds[0].status = "succeeded";
    mocks.orders.ord_1 = order("ord_1", {
      status: "refunded",
      refundable_amount: 0,
      refunded_amount: 2900,
    });
    await expect(
      processRefund(
        row({ attempts: 2, orders: [{ order_id: "ord_1", net: 2900 }], planned_cents: 2900 })
      )
    ).resolves.toBe("refunded");
    expect(mocks.refundsCreate).toHaveBeenCalledTimes(1);
    expect(lastUpdate()).toMatchObject({
      status: "refunded",
      refund_ids: ["ref_slow"],
      refunded_cents: 2900,
      // The first pass's list is kept.
      orders: [{ order_id: "ord_1", net: 2900 }],
    });
  });

  it("hands a refund that failed at Polar to a person instead of trying again", async () => {
    mocks.refunds.push({
      id: "ref_failed",
      status: "failed",
      amount: 2900,
      order_id: "ord_1",
      metadata: { [REFUND_METADATA_KEY]: "row_1" },
    });

    await expect(processRefund(row())).resolves.toBe("failed");
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: "failed", last_error: "refund_failed_at_polar" });
  });

  it("sends an approval with nothing prepared back to a person, refunding nothing", async () => {
    await expect(
      processRefund(row({ target: "subscription:sub_x", approved_at: "2026-11-03T11:59:00Z" }))
    ).resolves.toBe("held");

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({
      status: "held",
      hold_reason: "manual",
      approved_at: null,
      planned_cents: 2900,
    });
  });

  it("sends an approval with nothing prepared back to a person, flagged while its subscription is live", async () => {
    mocks.subscriptionsGet.mockResolvedValueOnce({ status: "active", ended_at: null });

    await expect(
      processRefund(row({ target: "subscription:sub_x", approved_at: "2026-11-03T11:59:00Z" }))
    ).resolves.toBe("held");

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({
      status: "held",
      hold_reason: "manual",
      approved_at: null,
      planned_cents: 2900,
      last_error: "subscription_live",
    });
    expect(mocks.reportError).toHaveBeenCalledWith(
      "[refunds] refund held for review",
      undefined,
      expect.objectContaining({ holdReason: "manual", code: "subscription_live" })
    );
  });

  it("tries again when the check after a refusal cannot reach Polar", async () => {
    mocks.refundsCreate.mockRejectedValueOnce({ statusCode: 422 });
    mocks.ordersGet
      .mockImplementationOnce(async () => order("ord_1"))
      .mockRejectedValueOnce({ statusCode: 503 });

    await expect(processRefund(row())).resolves.toBe("retry");
    expect(lastUpdate()).toMatchObject({ last_error: "polar_unavailable" });
    expect(lastUpdate()).not.toHaveProperty("status");
  });

  it("holds a queued refund once automatic refunds are turned off", async () => {
    mocks.settings.POLAR_AUTO_REFUNDS = false;

    await expect(processRefund(row())).resolves.toBe("held");

    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({
      status: "held",
      hold_reason: "manual",
      planned_cents: 2900,
    });
  });

  it("still refunds a row a person approved while automatic refunds are off", async () => {
    mocks.settings.POLAR_AUTO_REFUNDS = false;

    await expect(
      processRefund(
        row({ approved_at: "2026-11-03T11:59:00Z", orders: [{ order_id: "ord_1", net: 2900 }] })
      )
    ).resolves.toBe("refunded");
    expect(mocks.refundsCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps what a pass refunded when a later order fails", async () => {
    mocks.orders = { a: order("a"), b: order("b", { refundable_amount: 400 }) };
    mocks.refundsCreate.mockImplementationOnce(async (body: Record<string, unknown>) => {
      const refund = {
        id: "ref_a",
        status: "succeeded",
        amount: body.amount,
        tax_amount: 725,
        order_id: body.order_id,
        metadata: body.metadata,
      };
      mocks.refunds.push(refund);
      return refund;
    });
    mocks.refundsCreate.mockRejectedValueOnce({ statusCode: 400, code: "RefundDisputedPayment" });

    await expect(processRefund(row({ target: "subscription:sub_2" }))).resolves.toBe("failed");
    expect(lastUpdate()).toMatchObject({
      status: "failed",
      last_error: "RefundDisputedPayment",
      refund_ids: ["ref_a"],
      refunded_cents: 2900,
    });
  });

  it("tries a refund that failed at Polar again once a person approved the row again", async () => {
    mocks.refunds.push({
      id: "ref_failed",
      status: "failed",
      amount: 2900,
      order_id: "ord_1",
      metadata: { [REFUND_METADATA_KEY]: "row_1" },
    });

    await expect(
      processRefund(
        row({ approved_at: "2026-11-03T11:59:00Z", orders: [{ order_id: "ord_1", net: 2900 }] })
      )
    ).resolves.toBe("refunded");
    expect(mocks.refundsCreate).toHaveBeenCalledTimes(1);
  });

  it("tries again later when Polar is unavailable", async () => {
    mocks.refundsCreate.mockRejectedValueOnce({ statusCode: 503 });

    await expect(processRefund(row())).resolves.toBe("retry");

    expect(lastUpdate()).toMatchObject({ last_error: "polar_unavailable" });
    expect(lastUpdate()).not.toHaveProperty("status");
  });

  it("gives up and reports after the last attempt", async () => {
    mocks.refundsCreate.mockRejectedValueOnce({ statusCode: 503 });

    await expect(processRefund(row({ attempts: 14 }))).resolves.toBe("failed");

    expect(lastUpdate()).toMatchObject({ status: "failed", last_error: "polar_unavailable" });
    expect(mocks.reportError).toHaveBeenCalledWith(
      "[refunds] refund failed",
      expect.anything(),
      expect.objectContaining({ code: "polar_unavailable" })
    );
  });

  it("reports a refund Polar refuses, such as a disputed payment", async () => {
    mocks.refundsCreate.mockRejectedValueOnce({ statusCode: 400, code: "RefundDisputedPayment" });

    await expect(processRefund(row())).resolves.toBe("failed");

    expect(lastUpdate()).toMatchObject({ status: "failed", last_error: "RefundDisputedPayment" });
  });

  it("takes a refusal for an order refunded meanwhile as done", async () => {
    // Polar refunded it against a chargeback between the read and the refund.
    mocks.refundsCreate.mockRejectedValueOnce({ statusCode: 422 });
    mocks.ordersGet
      .mockImplementationOnce(async () => order("ord_1"))
      .mockImplementationOnce(async () =>
        order("ord_1", { status: "refunded", refundable_amount: 0 })
      );

    await expect(processRefund(row())).resolves.toBe("nothing");

    expect(lastUpdate()).toMatchObject({ status: "nothing" });
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("reports a target Polar does not know", async () => {
    mocks.ordersGet.mockRejectedValueOnce({ statusCode: 404, code: "ResourceNotFound" });

    await expect(processRefund(row())).resolves.toBe("failed");
    expect(lastUpdate()).toMatchObject({ status: "failed", last_error: "ResourceNotFound" });
  });
});

describe("a subscription Polar still has live", () => {
  const live = { status: "active", ended_at: null };

  it("is refunded once Polar has it ended", async () => {
    await expect(processRefund(row({ target: "subscription:sub_2" }))).resolves.toBe("refunded");
    expect(mocks.subscriptionsGet).toHaveBeenCalledWith("sub_2");
    expect(mocks.refundsCreate).toHaveBeenCalledTimes(1);
  });

  it("waits a little for the revoke its call site makes, refunding nothing", async () => {
    mocks.subscriptionsGet.mockResolvedValueOnce(live);
    const created = new Date(NOW - 60_000).toISOString();

    await expect(
      processRefund(row({ target: "subscription:sub_2", created_at: created }))
    ).resolves.toBe("waiting");
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ last_error: "subscription_live" });
    expect(lastUpdate()).not.toHaveProperty("status");
  });

  it("is held for a person once the wait is over, past due counting as live", async () => {
    mocks.subscriptionsGet.mockResolvedValueOnce({ status: "past_due", ended_at: null });
    const created = new Date(NOW - LIVE_SUBSCRIPTION_GRACE_MS - 1).toISOString();

    await expect(
      processRefund(row({ target: "subscription:sub_2", created_at: created }))
    ).resolves.toBe("held");
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({
      status: "held",
      last_error: "subscription_live",
      approved_at: null,
      planned_cents: 2900,
    });
    // Its hold reason is left alone (none: automatic refunds queued it), and
    // the slow check comes back for it.
    expect(lastUpdate()).not.toHaveProperty("hold_reason");
    expect(Date.parse(String(lastUpdate()?.next_attempt_at))).toBeGreaterThan(NOW);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError.mock.calls[0][2]).toMatchObject({ code: "subscription_live" });
  });

  it.each([
    [{ status: "active", ended_at: null }, false],
    [{ status: "past_due", ended_at: null }, false],
    [{ status: "unpaid", ended_at: null }, false],
    [{ status: "paused", ended_at: null }, false],
    [{ status: "incomplete", ended_at: null }, false],
    [{ status: "something_new", ended_at: null }, false],
    [{ ended_at: null }, false],
    [{ status: "canceled", ended_at: null }, true],
    [{ status: "incomplete_expired", ended_at: null }, true],
    [{ status: "active", ended_at: "2026-11-03T11:30:01Z" }, true],
  ])("counts %o as ended: %s", (subscription, ended) => {
    expect(hasSubscriptionEnded(subscription)).toBe(ended);
  });

  it("is not refunded while paused, unpaid or in a status we do not know", async () => {
    for (const status of ["paused", "unpaid", "something_new"]) {
      mocks.subscriptionsGet.mockResolvedValueOnce({ status, ended_at: null });
      await expect(
        processRefund(
          row({ target: "subscription:sub_2", created_at: new Date(NOW).toISOString() })
        )
      ).resolves.toBe("waiting");
    }
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });

  it("stays queued with the usual backoff, the last wait ending with the grace", async () => {
    const created = NOW - 10 * 60_000;
    mocks.subscriptionsGet.mockResolvedValueOnce(live);
    // A first look: two minutes, well inside the grace.
    await expect(
      processRefund(
        row({ target: "subscription:sub_2", created_at: new Date(created).toISOString() })
      )
    ).resolves.toBe("waiting");
    expect(lastUpdate()?.next_attempt_at).toBe(new Date(NOW + 2 * 60_000).toISOString());

    // The fourth would wait 16 minutes: cut short to the grace's end.
    mocks.subscriptionsGet.mockResolvedValueOnce(live);
    await expect(
      processRefund(
        row({
          target: "subscription:sub_2",
          attempts: 4,
          created_at: new Date(created).toISOString(),
        })
      )
    ).resolves.toBe("waiting");
    expect(lastUpdate()?.next_attempt_at).toBe(
      new Date(created + LIVE_SUBSCRIPTION_GRACE_MS).toISOString()
    );
    expect(lastUpdate()).not.toHaveProperty("status");
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("is held rather than failed when it runs out of attempts inside the grace", async () => {
    mocks.subscriptionsGet.mockResolvedValueOnce(live);

    await expect(
      processRefund(
        row({ target: "subscription:sub_2", attempts: 14, created_at: new Date(NOW).toISOString() })
      )
    ).resolves.toBe("held");
    expect(lastUpdate()).toMatchObject({ status: "held", last_error: "subscription_live" });
  });

  it("gets the grace again from the moment a person approved it", async () => {
    mocks.subscriptionsGet.mockResolvedValueOnce(live);

    await expect(
      processRefund(
        row({
          target: "subscription:sub_2",
          attempts: 1,
          created_at: "2026-11-01T12:00:00Z",
          approved_at: new Date(NOW - 60_000).toISOString(),
          orders: [{ order_id: "ord_1", net: 2900, tax: 725, created_at: "", billing_reason: "" }],
        })
      )
    ).resolves.toBe("waiting");
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });

  it("holds without the flag when it ended and automatic refunds were turned off meanwhile", async () => {
    mocks.settings.POLAR_AUTO_REFUNDS = false;

    await expect(
      processRefund(row({ target: "subscription:sub_2", last_error: "subscription_live" }))
    ).resolves.toBe("held");
    expect(lastUpdate()).toMatchObject({
      status: "held",
      hold_reason: "manual",
      last_error: null,
    });
  });

  it("is held again when a person approved it while it was still live", async () => {
    mocks.subscriptionsGet.mockResolvedValueOnce(live);
    const created = new Date(NOW - LIVE_SUBSCRIPTION_GRACE_MS - 1).toISOString();

    await expect(
      processRefund(
        row({
          target: "subscription:sub_2",
          created_at: created,
          // Approved before the revoke it needed, and the grace has run out since.
          approved_at: created,
          orders: [
            {
              order_id: "ord_1",
              net: 2900,
              tax: 725,
              created_at: "2026-11-03T11:00:00Z",
              billing_reason: "subscription_create",
            },
          ],
        })
      )
    ).resolves.toBe("held");
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: "held", approved_at: null });
  });

  it("is prepared for the review with the reason shown", async () => {
    mocks.settings.POLAR_AUTO_REFUNDS = false;
    mocks.subscriptionsGet.mockResolvedValueOnce(live);

    await expect(
      processRefund(row({ status: "held", hold_reason: "manual", target: "subscription:sub_2" }))
    ).resolves.toBe("prepared");
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ planned_cents: 2900, last_error: "subscription_live" });
    // Checked again soon: the revoke may land just after the worker looked.
    expect(lastUpdate()?.next_attempt_at).toBe(new Date(NOW + 2 * 60_000).toISOString());
  });

  it("tries again later when Polar cannot say", async () => {
    mocks.subscriptionsGet.mockRejectedValueOnce({ statusCode: 503 });

    await expect(processRefund(row({ target: "subscription:sub_2" }))).resolves.toBe("retry");
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });

  it("leaves an order target alone", async () => {
    await expect(processRefund(row())).resolves.toBe("refunded");
    expect(mocks.subscriptionsGet).not.toHaveBeenCalled();
  });
});

describe("a row held because its subscription was live", () => {
  const live = { status: "active", ended_at: null };
  const lines = [
    {
      order_id: "ord_1",
      net: 2900,
      tax: 725,
      created_at: "2026-11-03T11:00:00Z",
      billing_reason: "subscription_create",
    },
  ];
  const flagged = (overrides: Record<string, unknown> = {}) =>
    row({
      target: "subscription:sub_2",
      status: "held",
      hold_reason: null,
      last_error: "subscription_live",
      orders: lines,
      planned_cents: 2900,
      attempts: 5,
      ...overrides,
    });

  it("is checked again later while Polar still has it live, reported no more", async () => {
    mocks.subscriptionsGet.mockResolvedValueOnce(live);

    await expect(processRefund(flagged())).resolves.toBe("waiting");
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(mocks.updates[0].status).toBe("held");
    expect(lastUpdate()).toMatchObject({ attempts: 6, planned_cents: 2900 });
    expect(lastUpdate()).not.toHaveProperty("status");
    expect(lastUpdate()).not.toHaveProperty("last_error");
    // At most an hour apart.
    expect(lastUpdate()?.next_attempt_at).toBe(new Date(NOW + LIVE_RECHECK_MAX_MS).toISOString());
  });

  it("goes back to the queue once ended, while automatic refunds are on", async () => {
    await expect(processRefund(flagged())).resolves.toBe("queued");
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    // Only while still held: a dismissal meanwhile stands.
    expect(mocks.updates[0].status).toBe("held");
    expect(lastUpdate()).toMatchObject({
      status: "pending",
      last_error: null,
      attempts: 0,
      orders: null,
      next_attempt_at: new Date(NOW).toISOString(),
    });

    // The queue then refunds it like any other.
    await expect(processRefund(row({ target: "subscription:sub_2", attempts: 1 }))).resolves.toBe(
      "refunded"
    );
  });

  it("loses the flag once ended and waits for a person while automatic refunds are off", async () => {
    mocks.settings.POLAR_AUTO_REFUNDS = false;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(processRefund(flagged())).resolves.toBe("prepared");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[refunds] subscription ended, duplicate_plan ready for review"
    );
    info.mockRestore();
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({
      hold_reason: "manual",
      last_error: null,
      planned_cents: 2900,
    });
    expect(lastUpdate()).not.toHaveProperty("status");
  });

  it("keeps the hold it had for a person once ended, automatic refunds or not", async () => {
    await expect(processRefund(flagged({ hold_reason: "over_cap" }))).resolves.toBe("prepared");
    expect(lastUpdate()).toMatchObject({ hold_reason: "over_cap", last_error: null });
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
  });

  it("only pushes the next check back when the orders cannot be read, however many checks ran", async () => {
    mocks.ordersList.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(processRefund(flagged({ attempts: 20 }))).resolves.toBe("waiting");
    expect(mocks.subscriptionsGet).not.toHaveBeenCalled();
    expect(mocks.refundsCreate).not.toHaveBeenCalled();
    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0].status).toBe("held");
    expect(lastUpdate()).toMatchObject({
      attempts: 21,
      last_error: "subscription_live",
      next_attempt_at: new Date(NOW + LIVE_RECHECK_MAX_MS).toISOString(),
    });
    expect(lastUpdate()).not.toHaveProperty("status");
  });

  it("only pushes the next check back when the subscription cannot be read", async () => {
    mocks.subscriptionsGet.mockRejectedValueOnce({ statusCode: 503 });

    await expect(processRefund(flagged({ attempts: 14 }))).resolves.toBe("waiting");
    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ attempts: 15, last_error: "subscription_live" });
    expect(lastUpdate()).not.toHaveProperty("status");
  });

  it("closes once ended with nothing left to refund", async () => {
    mocks.orders = { ord_1: order("ord_1", { status: "refunded", refundable_amount: 0 }) };

    await expect(processRefund(flagged())).resolves.toBe("nothing");
    expect(lastUpdate()).toMatchObject({ status: "nothing", last_error: null });
  });

  it("is leased by the slow check only while still held, flagged and free", async () => {
    mocks.rechecks.push(flagged());

    const rows = await claimLiveRechecks();
    expect(rows).toHaveLength(1);
    expect(mocks.leases).toHaveLength(1);
    expect(mocks.leases[0].ids).toEqual(["row_1"]);
    expect(mocks.leases[0].filters).toMatchObject({
      status: "held",
      last_error: "subscription_live",
      or: expect.stringContaining("lease_until.is.null"),
    });
  });
});

describe("runRefunds", () => {
  it("works every claimed row and counts the outcomes", async () => {
    mocks.claimed.push(
      row(),
      row({ id: "row_2", status: "held", hold_reason: "manual", target: "order:ord_1" })
    );

    await expect(runRefunds()).resolves.toEqual({ refunded: 1, prepared: 1 });
  });

  it("works held rows due for the slow check too", async () => {
    mocks.rechecks.push(
      row({
        id: "row_3",
        target: "subscription:sub_2",
        status: "held",
        last_error: "subscription_live",
        orders: [],
      })
    );
    mocks.subscriptionsGet.mockResolvedValueOnce({ status: "active", ended_at: null });

    await expect(runRefunds()).resolves.toEqual({ waiting: 1 });
  });
});

describe("isTransientPolarError", () => {
  it("retries network trouble, rate limits and server errors, nothing else", () => {
    expect(isTransientPolarError({ statusCode: 502 })).toBe(true);
    expect(isTransientPolarError({ statusCode: 429 })).toBe(true);
    expect(isTransientPolarError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientPolarError({ statusCode: 422 })).toBe(false);
    expect(isTransientPolarError({ statusCode: 403 })).toBe(false);
  });
});
