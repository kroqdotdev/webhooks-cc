import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: { POLAR_AUTO_REFUNDS: true, POLAR_AUTO_REFUND_MAX_CENTS: 30_000 },
  upserts: [] as Array<{ row: Record<string, unknown>; options: unknown }>,
  updates: [] as Array<{ id: unknown; patch: Record<string, unknown> }>,
  claimed: [] as Record<string, unknown>[],
  orders: {} as Record<string, Record<string, unknown>>,
  refunds: [] as Record<string, unknown>[],
  ordersGet: vi.fn(),
  ordersList: vi.fn(),
  refundsList: vi.fn(),
  refundsCreate: vi.fn(),
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
      update: (patch: Record<string, unknown>) => ({
        eq: async (_column: string, id: unknown) => {
          mocks.updates.push({ id, patch });
          return { error: null };
        },
      }),
    }),
    rpc: async () => ({ data: mocks.claimed, error: null }),
  }),
}));

import {
  isTransientPolarError,
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
  mocks.orders = { ord_1: order("ord_1") };
  mocks.refunds = [];
  mocks.ordersGet.mockImplementation(async (id: string) => mocks.orders[id]);
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

describe("runRefunds", () => {
  it("works every claimed row and counts the outcomes", async () => {
    mocks.claimed.push(
      row(),
      row({ id: "row_2", status: "held", hold_reason: "manual", target: "order:ord_1" })
    );

    await expect(runRefunds()).resolves.toEqual({ refunded: 1, prepared: 1 });
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
