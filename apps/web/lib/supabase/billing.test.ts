import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  reportError: vi.fn(),
  createPolarClient: vi.fn(),
  getPolarCheckoutConfig: vi.fn(),
  reconcileAddonsWithPlan: vi.fn(),
  recordRefund: vi.fn(),
  supersedeCheckoutLinks: vi.fn(),
  auditSystemEvent: vi.fn(),
}));

// The customer the event names, which a link named by its metadata must have.
const CUSTOMER_OF_EVENT = "cus_1";

vi.mock("@/lib/billing/refunds", () => ({
  recordRefund: mockFns.recordRefund,
  refundTargetKey: (target: { subscription: string }) => `subscription:${target.subscription}`,
}));
vi.mock("@/lib/billing/checkout-link-rows", () => ({
  supersedeCheckoutLinks: mockFns.supersedeCheckoutLinks,
}));

vi.mock("@/lib/polar", async (importOriginal) => ({
  // The real product matching reads the product env vars set in each test.
  planForProduct: (await importOriginal<typeof import("@/lib/polar")>()).planForProduct,
  planProductId: (await importOriginal<typeof import("@/lib/polar")>()).planProductId,
  createPolarClient: mockFns.createPolarClient,
  getPolarCheckoutConfig: mockFns.getPolarCheckoutConfig,
  polarAppUrl: () => "https://webhooks.cc",
  unwrapPolarResult: <T>(result: T) => result,
}));

vi.mock("./capacity-billing", () => ({
  reconcileAddonsWithPlan: mockFns.reconcileAddonsWithPlan,
}));

vi.mock("@/lib/observability", () => ({ reportError: mockFns.reportError }));
vi.mock("@/lib/audit", () => ({ auditSystemEvent: mockFns.auditSystemEvent }));

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

import {
  addMonthsUtc,
  addMonthUtc,
  annualQuotaWindow,
  applyPolarWebhookEvent,
  changePlanForUser,
  createCustomerPortalForUser,
  keepCurrentPlanForUser,
  remainingShare,
} from "./billing";

// Plan events apply the subscription as Polar has it now: by default the
// event's own payload, or what a test puts here.
let polarSubscriptions: Record<string, Record<string, unknown>> = {};
const polarRevoke = vi.fn();
// What subscriptions.list answers: the customer's live subscriptions.
const polarList = vi.fn();

async function apply(type: string, payload: Record<string, unknown>) {
  const id = String(payload.id);
  if (!polarSubscriptions[id]) polarSubscriptions[id] = payload;
  return applyPolarWebhookEvent(type, payload);
}

// ---------------------------------------------------------------------------
// Minimal supabase-js query-builder double (same shape as team-billing.test.ts).
// Responses are queued per `${table}:${operation}`; writes are recorded so the
// tests can assert the exact update payloads.
// ---------------------------------------------------------------------------

interface QueryResult {
  data?: unknown;
  error?: unknown;
}

interface RecordedCall {
  table: string;
  op: string;
  payload?: unknown;
  filters?: Array<[string, string, unknown]>;
}

let recorded: RecordedCall[] = [];

function createFakeAdmin(responses: Record<string, QueryResult[]>) {
  return {
    from(table: string) {
      let op = "select";
      let payload: unknown;
      const filters: Array<[string, string, unknown]> = [];

      const take = (): QueryResult => {
        const queue = responses[`${table}:${op}`];
        const next = queue?.shift();
        // An update reads back the row it wrote, unless a test says otherwise.
        const written = op === "update" ? [{ id: "user_1" }] : null;
        return { data: written, error: null, ...next };
      };

      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["in", "order", "limit", "select"] as const) {
        builder[method] = chain;
      }

      for (const method of ["eq", "is", "neq"] as const) {
        builder[method] = (field: string, value: unknown) => {
          filters.push([method, field, value]);
          return builder;
        };
      }

      for (const method of ["insert", "update", "delete"] as const) {
        builder[method] = (value?: unknown) => {
          op = method;
          payload = value;
          return builder;
        };
      }

      const settle = () => {
        recorded.push({ table, op, payload, filters: [...filters] });
        return Promise.resolve(take());
      };

      builder.maybeSingle = settle;
      builder.single = settle;
      builder.then = (
        onFulfilled?: (value: QueryResult) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) => settle().then(onFulfilled, onRejected);

      return builder;
    },
  };
}

function userUpdatePayload(): Record<string, unknown> | undefined {
  return recorded.find((call) => call.table === "users" && call.op === "update")?.payload as
    Record<string, unknown> | undefined;
}

// A personal-customer payload: extractCustomerUserId resolves the user id from
// the customer object, so no users lookup-by-customer query happens.
function subscriptionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_1",
    customer_id: "cus_1",
    status: "active",
    customer: { id: "cus_1", external_id: "user_1", metadata: { userId: "user_1" } },
    // Polar's timestamps carry microseconds; stored values keep milliseconds.
    current_period_start: "2026-08-01T00:00:00.000000Z",
    current_period_end: "2026-08-31T00:00:00.000000Z",
    cancel_at_period_end: false,
    ...overrides,
  };
}

function storedUser(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      polar_subscription_id: "sub_1",
      subscription_status: "active",
      plan: "pro",
      period_start: "2026-07-01T00:00:00.000Z",
      period_end: "2026-07-31T00:00:00.000Z",
      prorated_window: null,
      ...overrides,
    },
  };
}

beforeEach(() => {
  recorded = [];
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  polarSubscriptions = {};
  mockFns.createPolarClient.mockReturnValue({
    subscriptions: {
      get: async (id: string) => polarSubscriptions[id],
      revoke: polarRevoke,
      list: polarList,
    },
  });
  polarList.mockResolvedValue({ items: [] });
});

describe("applyPolarWebhookEvent subscription.created/updated", () => {
  test("renewal (same subscription, later period start) resets usage", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser()], "users:update": [{}] })
    );

    await apply("subscription.updated", subscriptionEvent());

    const payload = userUpdatePayload();
    expect(payload).toMatchObject({
      requests_used: 0,
      period_start: "2026-08-01T00:00:00.000Z",
      period_end: "2026-08-31T00:00:00.000Z",
      plan: "pro",
    });
  });

  test("repeat event for the same period keeps usage", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ period_start: "2026-08-01T00:00:00.000Z" })],
        "users:update": [{}],
      })
    );

    await apply("subscription.updated", subscriptionEvent());

    const payload = userUpdatePayload();
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("requests_used");
  });

  test("stale event (older period start) keeps the stored period bounds and usage", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ period_start: "2026-09-01T00:00:00.000Z" })],
        "users:update": [{}],
      })
    );

    await apply("subscription.updated", subscriptionEvent());

    const payload = userUpdatePayload();
    expect(payload).toBeDefined();
    expect(payload!.period_start).toBeUndefined();
    expect(payload!.period_end).toBeUndefined();
    expect(payload).not.toHaveProperty("requests_used");
  });

  test("a new subscription id resets usage even without stored period bounds", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ polar_subscription_id: "sub_old", period_start: null })],
        "users:update": [{}],
      })
    );

    await apply("subscription.created", subscriptionEvent());

    const payload = userUpdatePayload();
    expect(payload).toMatchObject({
      requests_used: 0,
      polar_subscription_id: "sub_1",
    });
  });

  test("a new subscription clears the quota email window", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ polar_subscription_id: null, period_start: null })],
        "users:update": [{}],
      })
    );

    await applyPolarWebhookEvent("subscription.created", subscriptionEvent());

    expect(userUpdatePayload()).toMatchObject({ quota_email_sent_at: null });
    // The write is still guarded on the state it read, null columns included.
    const update = recorded.find((call) => call.table === "users" && call.op === "update");
    expect(update!.filters).toContainEqual(["is", "polar_subscription_id", null]);
    expect(update!.filters).toContainEqual(["is", "period_start", null]);
  });

  test("a renewal or an update of the same subscription keeps the quota email window", async () => {
    for (const periodStart of ["2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"]) {
      recorded = [];
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "users:select": [storedUser({ period_start: periodStart })],
          "users:update": [{}],
        })
      );

      await applyPolarWebhookEvent("subscription.updated", subscriptionEvent());

      expect(userUpdatePayload()).not.toHaveProperty("quota_email_sent_at");
    }
  });

  test("an unrecognized status keeps the stored status instead of nulling it", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ subscription_status: "canceled" })],
        "users:update": [{}],
      })
    );

    await apply("subscription.updated", subscriptionEvent({ status: "some_future_status" }));

    expect(userUpdatePayload()).toMatchObject({ subscription_status: "canceled" });
  });

  test("the renewal reset is conditioned on the observed subscription id and period start", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser()], "users:update": [{}] })
    );

    await apply("subscription.updated", subscriptionEvent());

    // Two overlapping deliveries of the same renewal must not both zero the
    // usage counter: the write carries optimistic filters on the state that
    // was read, so the loser matches no rows.
    const update = recorded.find((call) => call.table === "users" && call.op === "update");
    expect(update).toBeDefined();
    expect(update!.filters).toContainEqual(["eq", "polar_subscription_id", "sub_1"]);
    expect(update!.filters).toContainEqual(["eq", "period_start", "2026-07-01T00:00:00.000Z"]);
  });

  test("a non-renewal update is compare-and-swapped on the observed state too", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ period_start: "2026-08-01T00:00:00.000Z" })],
        "users:update": [{}],
      })
    );

    await apply("subscription.updated", subscriptionEvent());

    // An updated event read before a concurrent revoke must not resurrect the
    // revoked subscription's state after it.
    const update = recorded.find((call) => call.table === "users" && call.op === "update");
    expect(update).toBeDefined();
    expect(update!.filters).toContainEqual(["eq", "polar_subscription_id", "sub_1"]);
    expect(update!.filters).toContainEqual(["eq", "period_start", "2026-08-01T00:00:00.000Z"]);
    expect(update!.payload).not.toHaveProperty("requests_used");
  });

  test("ends a live subscription whose account is gone and records its refund", async () => {
    // A checkout that completed after the account was deleted.
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [{ data: null }] })
    );

    await apply("subscription.created", subscriptionEvent());

    expect(userUpdatePayload()).toBeUndefined();
    expect(polarRevoke).toHaveBeenCalledWith("sub_1");
    expect(mockFns.recordRefund).toHaveBeenCalledWith({
      target: { subscription: "sub_1" },
      reason: "deleted_account",
      userId: "user_1",
    });
    // Recorded first: after the revoke a redelivery would read it as ended.
    expect(mockFns.recordRefund.mock.invocationCallOrder[0]).toBeLessThan(
      polarRevoke.mock.invocationCallOrder[0]
    );
  });

  test("records nothing when Polar ended the subscription since the event was read", async () => {
    // The account deletion's own revoke landed between the two reads.
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [{ data: null }] })
    );
    let reads = 0;
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: {
        get: async () =>
          ++reads === 1
            ? subscriptionEvent()
            : subscriptionEvent({ status: "canceled", ended_at: "2026-08-02T00:00:00Z" }),
        revoke: polarRevoke,
      },
    });

    await apply("subscription.updated", subscriptionEvent());

    expect(polarRevoke).not.toHaveBeenCalled();
    expect(mockFns.recordRefund).not.toHaveBeenCalled();
  });

  test("leaves alone a late event for the subscription the account deletion ended", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [{ data: null }] })
    );
    // Polar's current state, which the handler reads, is ended.
    polarSubscriptions.sub_1 = subscriptionEvent({
      status: "canceled",
      ended_at: "2026-08-02T00:00:00Z",
    });

    await apply("subscription.updated", subscriptionEvent());

    expect(userUpdatePayload()).toBeUndefined();
    expect(polarRevoke).not.toHaveBeenCalled();
    expect(mockFns.recordRefund).not.toHaveBeenCalled();
  });
});

describe("plan changes within a period", () => {
  const AUGUST = {
    period_start: "2026-08-01T00:00:00.000Z",
    period_end: "2026-08-31T00:00:00.000Z",
  };

  beforeEach(() => {
    vi.stubEnv("POLAR_PRO_PRODUCT_ID", "prod_pro");
    vi.stubEnv("POLAR_BUSINESS_PRODUCT_ID", "prod_business");
    vi.stubEnv("POLAR_BUSINESS_ANNUAL_PRODUCT_ID", "prod_business_year");
  });

  test("remainingShare is the part of the period still to come", () => {
    const start = "2026-08-01T00:00:00.000Z";
    const end = "2026-08-31T00:00:00.000Z";
    expect(remainingShare(start, end, Date.parse("2026-08-16T00:00:00.000Z"))).toBe(0.5);
    expect(remainingShare(start, end, Date.parse("2026-07-01T00:00:00.000Z"))).toBe(1);
    expect(remainingShare(start, end, Date.parse("2026-09-01T00:00:00.000Z"))).toBe(0);
    expect(remainingShare(end, start, Date.now())).toBe(0);
  });

  test("Pro to Business mid-period grants the extra capacity pro rata and keeps usage", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-16T00:00:00.000Z"), toFake: ["Date"] });
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser(AUGUST)],
        "users:update": [{}],
      })
    );

    await apply("subscription.updated", subscriptionEvent({ product_id: "prod_business" }));

    const payload = userUpdatePayload();
    expect(payload).toMatchObject({
      plan: "business",
      // Pro's 100,000 plus half of Business's extra 150,000.
      request_limit: 175_000,
      // Pro's 100 pages plus half of Business's extra 1,900.
      prorated_pages: 1_050,
      prorated_window: AUGUST.period_start,
    });
    expect(payload).not.toHaveProperty("requests_used");
  });

  test("a later event in the same window keeps the pro rata allowance", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          storedUser({ ...AUGUST, plan: "business", prorated_window: AUGUST.period_start }),
        ],
        "users:update": [{}],
      })
    );

    await apply("subscription.updated", subscriptionEvent({ product_id: "prod_business" }));

    const payload = userUpdatePayload();
    expect(payload).toMatchObject({ plan: "business" });
    expect(payload).not.toHaveProperty("request_limit");
    expect(payload).not.toHaveProperty("prorated_pages");
  });

  test("the renewal gives the full allowance and ends the pro rata one", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          storedUser({
            plan: "business",
            prorated_window: "2026-07-01T00:00:00.000Z",
          }),
        ],
        "users:update": [{}],
      })
    );

    await apply("subscription.updated", subscriptionEvent({ product_id: "prod_business" }));

    expect(userUpdatePayload()).toMatchObject({
      requests_used: 0,
      request_limit: 250_000,
      prorated_pages: null,
      prorated_window: null,
    });
  });

  test("a change Polar holds for the renewal is recorded as pending, not applied", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ ...AUGUST, plan: "business" })],
        "users:update": [{}],
      })
    );

    await apply(
      "subscription.updated",
      subscriptionEvent({
        product_id: "prod_business",
        pending_update: { product_id: "prod_pro", seats: null, units: null },
      })
    );

    expect(userUpdatePayload()).toMatchObject({
      plan: "business",
      request_limit: 250_000,
      pending_plan: "pro",
      pending_interval: "month",
    });
  });

  test("an event without a pending update clears one recorded before", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ ...AUGUST, plan: "business" })],
        "users:update": [{}],
      })
    );

    await apply(
      "subscription.updated",
      subscriptionEvent({ product_id: "prod_business", pending_update: null })
    );

    expect(userUpdatePayload()).toMatchObject({ pending_plan: null, pending_interval: null });
  });
});

describe("createCustomerPortalForUser", () => {
  test("opens the portal for the account's own Polar customer, back to the plan page", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [{ data: { id: "user_1", polar_customer_id: "cus_1" } }] })
    );
    const create = vi.fn().mockResolvedValue({ customer_portal_url: "https://polar.test/portal" });
    mockFns.createPolarClient.mockReturnValue({ customerSessions: { create } });

    await expect(createCustomerPortalForUser("user_1")).resolves.toBe("https://polar.test/portal");
    expect(create).toHaveBeenCalledWith({
      customer_id: "cus_1",
      return_url: "https://webhooks.cc/account/plan",
    });
  });

  test("refuses an account that never had a Polar customer", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [{ data: { id: "user_1", polar_customer_id: null } }] })
    );

    await expect(createCustomerPortalForUser("user_1")).rejects.toMatchObject({
      code: "no_customer",
    });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });
});

describe("changePlanForUser", () => {
  const update = vi.fn();

  beforeEach(() => {
    vi.stubEnv("POLAR_PRO_PRODUCT_ID", "prod_pro");
    vi.stubEnv("POLAR_BUSINESS_PRODUCT_ID", "prod_business");
    vi.stubEnv("POLAR_BUSINESS_ANNUAL_PRODUCT_ID", "prod_business_year");
    update.mockReset();
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update } });
  });

  function billingUser(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        id: "user_1",
        email: "owner@example.com",
        name: null,
        plan: "pro",
        polar_customer_id: "cus_1",
        polar_subscription_id: "sub_1",
        cancel_at_period_end: false,
        billing_interval: "month",
        pending_plan: null,
        ...overrides,
      },
    };
  }

  test("Pro to Business monthly changes now, invoicing the rest of the period", async () => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "users:select": [billingUser()] }));

    await expect(changePlanForUser("user_1", "business", "month")).resolves.toEqual({
      applied: "now",
    });
    expect(update).toHaveBeenCalledWith("sub_1", {
      product_id: "prod_business",
      proration_behavior: "invoice",
    });
    expect(userUpdatePayload()).toBeUndefined();
  });

  test("a declined card on Pro to Business is payment_failed and changes nothing", async () => {
    const { errors } = await import("@polar-sh/sdk/2026-10");
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "users:select": [billingUser()] }));
    update.mockRejectedValueOnce(
      new errors.SubscriptionsUpdate402Error(402, {
        error: "PaymentFailed",
        detail: "Payment failed with reason: card_error.",
      })
    );

    await expect(changePlanForUser("user_1", "business", "month")).rejects.toMatchObject({
      name: "BillingActionError",
      code: "payment_failed",
    });
    expect(userUpdatePayload()).toBeUndefined();
  });

  test("a payment the bank wants confirmed has its own code, so an approval reads it as unknown", async () => {
    const { errors } = await import("@polar-sh/sdk/2026-10");
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "users:select": [billingUser()] }));
    update.mockRejectedValueOnce(
      new errors.SubscriptionsUpdate402Error(402, {
        error: "PaymentActionRequired",
        detail: "The payment needs to be confirmed.",
      })
    );

    await expect(changePlanForUser("user_1", "business", "month")).rejects.toMatchObject({
      name: "BillingActionError",
      code: "payment_action_required",
      message: expect.stringContaining("Polar receipt email"),
    });
  });

  test("an approved switch made now refuses before Polar near or past the period it was priced on", async () => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "users:select": [billingUser()] }));
    const soon = new Date(Date.now() + 30_000).toISOString();
    await expect(
      changePlanForUser("user_1", "business", "month", { periodEnd: soon })
    ).rejects.toMatchObject({ code: "quote_changed" });
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "users:select": [billingUser()] }));
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await expect(
      changePlanForUser("user_1", "business", "month", { periodEnd: past })
    ).rejects.toMatchObject({ code: "quote_changed" });
    expect(update).not.toHaveBeenCalled();

    // With the period well ahead it goes through.
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "users:select": [billingUser()] }));
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString();
    await expect(
      changePlanForUser("user_1", "business", "month", { periodEnd: later })
    ).resolves.toEqual({ applied: "now" });
  });

  test("Pro to Business annual waits for the renewal and shows as pending", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [billingUser()], "users:update": [{}] })
    );

    await expect(changePlanForUser("user_1", "business", "year")).resolves.toEqual({
      applied: "renewal",
    });
    expect(update).toHaveBeenCalledWith("sub_1", {
      product_id: "prod_business_year",
      proration_behavior: "next_period",
    });
    expect(userUpdatePayload()).toEqual({ pending_plan: "business", pending_interval: "year" });
    expect(mockFns.reconcileAddonsWithPlan).toHaveBeenCalledWith({
      kind: "user",
      userId: "user_1",
    });
  });

  test("Business to Pro waits for the renewal", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [billingUser({ plan: "business" })],
        "users:update": [{}],
      })
    );

    await expect(changePlanForUser("user_1", "pro", "month")).resolves.toEqual({
      applied: "renewal",
    });
    expect(update).toHaveBeenCalledWith("sub_1", {
      product_id: "prod_pro",
      proration_behavior: "next_period",
    });
    // Extra pages need Business: they are set to end with the period.
    expect(mockFns.reconcileAddonsWithPlan).toHaveBeenCalledWith({
      kind: "user",
      userId: "user_1",
    });
  });

  test("keeping the plan clears Polar's pending update and the recorded one", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [billingUser({ plan: "business", pending_plan: "pro" })],
        "users:update": [{}],
      })
    );

    await keepCurrentPlanForUser("user_1");
    expect(update).toHaveBeenCalledWith("sub_1", { pending_update: null });
    // Page add-ons a move away from Business set to end come back.
    expect(mockFns.reconcileAddonsWithPlan).toHaveBeenCalledWith({
      kind: "user",
      userId: "user_1",
    });
    expect(userUpdatePayload()).toEqual({ pending_plan: null, pending_interval: null });
  });

  test("keeping the plan without a waiting change is refused", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [billingUser({ plan: "business" })] })
    );

    await expect(keepCurrentPlanForUser("user_1")).rejects.toMatchObject({ code: "unchanged" });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("plan events apply Polar's current state", () => {
  beforeEach(() => {
    vi.stubEnv("POLAR_PRO_PRODUCT_ID", "prod_pro");
    vi.stubEnv("POLAR_BUSINESS_PRODUCT_ID", "prod_business");
    vi.stubEnv("POLAR_BUSINESS_ANNUAL_PRODUCT_ID", "prod_business_year");
  });

  test("a late event for an older state applies the subscription as it is now", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          storedUser({ plan: "business", period_start: "2026-08-01T00:00:00.000Z" }),
        ],
      })
    );
    // Polar has Business; the late event still says Pro.
    polarSubscriptions.sub_1 = subscriptionEvent({ product_id: "prod_business" });

    await apply("subscription.updated", subscriptionEvent({ product_id: "prod_pro" }));

    expect(userUpdatePayload()).toMatchObject({ plan: "business" });
  });

  test("a late event for an ended subscription that is not the account's changes nothing", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser({ polar_subscription_id: "sub_new" })] })
    );
    polarSubscriptions.sub_1 = subscriptionEvent({ status: "canceled" });

    await apply("subscription.updated", subscriptionEvent());

    expect(userUpdatePayload()).toBeUndefined();
  });

  test("a second live plan subscription is revoked and refunded, and the account keeps its own", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser({ polar_subscription_id: "sub_first" })] })
    );
    polarSubscriptions.sub_first = subscriptionEvent({
      id: "sub_first",
      started_at: "2026-08-01T10:00:00Z",
    });

    await apply(
      "subscription.created",
      subscriptionEvent({
        id: "sub_second",
        product_id: "prod_pro",
        checkout_id: "co_link",
        started_at: "2026-08-01T10:05:00Z",
      })
    );

    expect(polarRevoke).toHaveBeenCalledWith("sub_second");
    // A checkout link its session made reads superseded, never paid.
    expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalledWith(
      "co_link",
      undefined,
      CUSTOMER_OF_EVENT
    );
    expect(userUpdatePayload()).toBeUndefined();
    expect(mockFns.recordRefund).toHaveBeenCalledWith({
      target: { subscription: "sub_second" },
      reason: "duplicate_plan",
      userId: "user_1",
    });
    expect(mockFns.recordRefund.mock.invocationCallOrder[0]).toBeLessThan(
      polarRevoke.mock.invocationCallOrder[0]
    );
    // Superseded before the revoke too: a redelivery after a failed
    // supersede must not find the subscription ended and the link paid.
    expect(mockFns.supersedeCheckoutLinks.mock.invocationCallOrder[0]).toBeLessThan(
      polarRevoke.mock.invocationCallOrder[0]
    );
  });

  test("a failed supersede leaves the duplicate live, so the redelivery tries again", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser({ polar_subscription_id: "sub_first" })] })
    );
    polarSubscriptions.sub_first = subscriptionEvent({
      id: "sub_first",
      started_at: "2026-08-01T10:00:00Z",
    });
    mockFns.supersedeCheckoutLinks.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      apply(
        "subscription.created",
        subscriptionEvent({
          id: "sub_second",
          product_id: "prod_pro",
          checkout_id: "co_link",
          started_at: "2026-08-01T10:05:00Z",
        })
      )
    ).rejects.toThrow("connection reset");
    expect(polarRevoke).not.toHaveBeenCalled();
  });

  describe("a second live plan subscription is ended only beside a twin checkout", () => {
    interface Side {
      started_at?: string | null;
      created_at?: string | null;
    }

    async function second(
      stored: Side,
      event: Side & Record<string, unknown>,
      storedOverrides: Record<string, unknown> = {}
    ) {
      polarSubscriptions = {};
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({ "users:select": [storedUser({ polar_subscription_id: "sub_first" })] })
      );
      polarSubscriptions.sub_first = subscriptionEvent({
        id: "sub_first",
        started_at: null,
        created_at: null,
        ...stored,
        ...storedOverrides,
      });
      await apply(
        "subscription.created",
        subscriptionEvent({
          id: "sub_second",
          product_id: "prod_pro",
          checkout_id: "co_link",
          started_at: null,
          created_at: null,
          ...event,
        })
      );
    }

    function expectEnded() {
      expect(mockFns.recordRefund).toHaveBeenCalledWith({
        target: { subscription: "sub_second" },
        reason: "duplicate_plan",
        userId: "user_1",
      });
      expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalled();
      expect(polarRevoke).toHaveBeenCalledWith("sub_second");
      expect(mockFns.reportError).not.toHaveBeenCalled();
      expect(mockFns.auditSystemEvent).not.toHaveBeenCalled();
      expect(userUpdatePayload()).toBeUndefined();
    }

    function expectReported(reason: string) {
      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(mockFns.supersedeCheckoutLinks).not.toHaveBeenCalled();
      expect(polarRevoke).not.toHaveBeenCalled();
      expect(mockFns.reportError).toHaveBeenCalledTimes(1);
      expect(mockFns.reportError.mock.calls[0][2]).toEqual({
        userId: "user_1",
        storedSubscriptionId: "sub_first",
        eventSubscriptionId: "sub_second",
        reason,
      });
      // Kept in the audit log as well, with ids only.
      expect(mockFns.auditSystemEvent).toHaveBeenCalledTimes(1);
      expect(mockFns.auditSystemEvent).toHaveBeenCalledWith({
        action: "billing.duplicate_plan_reported",
        outcome: "refused",
        userId: "user_1",
        targetId: "sub_second",
        metadata: { stored_subscription_id: "sub_first", reason },
      });
      // The account keeps the one it holds.
      expect(userUpdatePayload()).toBeUndefined();
    }

    test("one that started just after the account's is ended", async () => {
      await second({ started_at: "2026-08-01T10:00:00Z" }, { started_at: "2026-08-01T11:59:00Z" });
      expectEnded();
    });

    test("one that started just before the account's (its event arrived late) is ended", async () => {
      await second({ started_at: "2026-08-01T10:00:00Z" }, { started_at: "2026-08-01T08:01:00Z" });
      expectEnded();
    });

    test("without started_at, created_at decides", async () => {
      await second({ created_at: "2026-08-01T10:00:00Z" }, { created_at: "2026-08-01T10:30:00Z" });
      expectEnded();
    });

    test("one that started long before the account's is reported, never revoked", async () => {
      // An annual plan whose id the row lost while Polar kept it live,
      // beside a plan bought again an hour ago.
      await second({ started_at: "2026-11-01T10:00:00Z" }, { started_at: "2026-02-01T10:00:00Z" });
      expectReported("not_a_twin");
    });

    test("one that started long after the account's is reported, never revoked", async () => {
      await second({ started_at: "2026-08-01T10:00:00Z" }, { started_at: "2026-08-01T12:00:01Z" });
      expectReported("not_a_twin");
    });

    test("both timestamps missing on either side is reported", async () => {
      await second({}, { started_at: "2026-08-01T10:00:00Z", created_at: "2026-08-01T10:00:00Z" });
      expectReported("not_a_twin");
      vi.clearAllMocks();
      recorded = [];
      await second({ started_at: "2026-08-01T10:00:00Z", created_at: "2026-08-01T10:00:00Z" }, {});
      expectReported("not_a_twin");
    });

    test("a product that is not a plan is reported, never revoked", async () => {
      await second(
        { started_at: "2026-08-01T10:00:00Z" },
        { started_at: "2026-08-01T10:05:00Z", product_id: "prod_something_else" }
      );
      expectReported("not_a_plan");
    });

    test("a subscription on another Polar customer is reported, never revoked", async () => {
      await second(
        { started_at: "2026-08-01T10:00:00Z" },
        { started_at: "2026-08-01T10:05:00Z" },
        { customer_id: "cus_other" }
      );
      expectReported("other_customer");
    });

    test("one Polar has already ended is reported, never revoked", async () => {
      await second(
        { started_at: "2026-08-01T10:00:00Z" },
        { started_at: "2026-08-01T10:05:00Z", ended_at: "2026-08-01T10:06:00Z" }
      );
      expectReported("ended");
    });

    test("a report already in the audit log is not written again", async () => {
      polarSubscriptions = {};
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "users:select": [storedUser({ polar_subscription_id: "sub_first" })],
          // A renewal or redelivery of a subscription reported before.
          "audit_events:select": [{ data: [{ id: "audit_1" }] }],
        })
      );
      polarSubscriptions.sub_first = subscriptionEvent({
        id: "sub_first",
        started_at: "2026-08-01T10:00:00Z",
      });
      await apply(
        "subscription.updated",
        subscriptionEvent({
          id: "sub_second",
          product_id: "prod_pro",
          started_at: "2026-02-01T10:00:00Z",
        })
      );

      // StatOSS still hears of it; the audit log keeps the first row only.
      expect(mockFns.reportError).toHaveBeenCalledTimes(1);
      expect(mockFns.auditSystemEvent).not.toHaveBeenCalled();
      expect(polarRevoke).not.toHaveBeenCalled();
      const lookup = recorded.find((call) => call.table === "audit_events");
      expect(lookup?.filters).toEqual([
        ["eq", "target_user_id", "user_1"],
        ["eq", "action", "billing.duplicate_plan_reported"],
        ["eq", "target_id", "sub_second"],
        ["eq", "metadata->>reason", "not_a_twin"],
      ]);
    });
  });

  test("a failed read of the held subscription changes nothing, so the redelivery decides", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser({ polar_subscription_id: "sub_first" })] })
    );
    const event = subscriptionEvent({
      id: "sub_second",
      product_id: "prod_pro",
      checkout_id: "co_link",
      started_at: "2026-08-01T10:05:00Z",
    });
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: {
        get: async (id: string) => {
          if (id === "sub_first") throw new Error("Polar unavailable");
          return event;
        },
        revoke: polarRevoke,
        list: polarList,
      },
    });

    await expect(applyPolarWebhookEvent("subscription.created", event)).rejects.toThrow(
      "Polar unavailable"
    );
    expect(mockFns.recordRefund).not.toHaveBeenCalled();
    expect(mockFns.supersedeCheckoutLinks).not.toHaveBeenCalled();
    expect(polarRevoke).not.toHaveBeenCalled();
    expect(userUpdatePayload()).toBeUndefined();
  });

  test("a new subscription replaces one Polar no longer has live", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser({ polar_subscription_id: "sub_old" })] })
    );
    polarSubscriptions.sub_old = subscriptionEvent({ id: "sub_old", status: "canceled" });

    await apply("subscription.created", subscriptionEvent());

    expect(polarRevoke).not.toHaveBeenCalled();
    expect(userUpdatePayload()).toMatchObject({ polar_subscription_id: "sub_1", requests_used: 0 });
  });

  test("a write that lost a race reads again and is applied", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          storedUser({ period_start: "2026-08-01T00:00:00.000Z" }),
          storedUser({ period_start: "2026-08-01T00:00:00.000Z" }),
        ],
        "users:update": [{ data: [] }, {}],
      })
    );

    await apply("subscription.updated", subscriptionEvent());

    const updates = recorded.filter((call) => call.table === "users" && call.op === "update");
    expect(updates).toHaveLength(2);
  });

  test("a run of lost races throws, so Polar delivers the event again", async () => {
    const august = storedUser({ period_start: "2026-08-01T00:00:00.000Z" });
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [august, august, august],
        "users:update": [{ data: [] }, { data: [] }, { data: [] }],
      })
    );

    await expect(apply("subscription.updated", subscriptionEvent())).rejects.toThrow(/retry/);
  });

  test("a late cancel or uncancel applies the subscription as it is now", async () => {
    vi.stubEnv("POLAR_PRO_PRODUCT_ID", "prod_pro");
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [{ data: { id: "user_1" } }], "users:update": [{}] })
    );
    // Kept after all: the late cancel event must not set it ending.
    polarSubscriptions.sub_1 = subscriptionEvent({ cancel_at_period_end: false });

    await apply("subscription.canceled", subscriptionEvent({ cancel_at_period_end: true }));

    expect(userUpdatePayload()).toEqual({
      cancel_at_period_end: false,
      subscription_status: "active",
    });
  });

  test("the pro rata share uses Polar's period, not one the cron stretched", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-16T00:00:00.000Z"), toFake: ["Date"] });
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        // The cron fallback stretched the stored period; Polar's is August.
        "users:select": [
          storedUser({
            period_start: "2026-08-01T00:00:00.000Z",
            period_end: "2026-09-30T00:00:00.000Z",
          }),
        ],
      })
    );

    await apply("subscription.updated", subscriptionEvent({ product_id: "prod_business" }));

    expect(userUpdatePayload()).toMatchObject({ request_limit: 175_000, prorated_pages: 1_050 });
  });

  test("a year that starts after the cron already moved the quota period keeps its usage", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          storedUser({
            plan: "business",
            billing_interval: "year",
            billing_period_end: "2026-08-01T00:00:00.000Z",
            period_start: "2026-08-01T00:00:00.000Z",
          }),
        ],
      })
    );

    await apply(
      "subscription.updated",
      subscriptionEvent({
        product_id: "prod_business_year",
        current_period_start: "2026-08-01T00:00:00.000Z",
        current_period_end: "2027-08-01T00:00:00.000Z",
      })
    );

    const payload = userUpdatePayload();
    expect(payload).toMatchObject({
      billing_period_end: "2027-08-01T00:00:00.000Z",
      period_end: "2026-09-01T00:00:00.000Z",
    });
    expect(payload).not.toHaveProperty("requests_used");
  });

  test("a year from the 31st opens its first window on the boundary the reset job counts", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser({ plan: "pro" })] })
    );

    await apply(
      "subscription.updated",
      subscriptionEvent({
        product_id: "prod_business_year",
        current_period_start: "2027-01-31T10:00:00.000000Z",
        current_period_end: "2028-01-31T10:00:00.000000Z",
      })
    );

    expect(userUpdatePayload()).toMatchObject({
      period_start: "2027-01-31T10:00:00.000Z",
      period_end: "2027-02-28T10:00:00.000Z",
      requests_used: 0,
    });
  });

  test("a yearly renewal just after the reset job opened a window keeps its usage", async () => {
    // A window that drifted to the 28th joined the rest of the year when the
    // job moved it on: the renewal on the 31st must not reset it again.
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          storedUser({
            plan: "business",
            billing_interval: "year",
            billing_period_end: "2028-01-31T10:00:00.000Z",
            period_start: "2028-01-28T10:00:00.000Z",
            period_end: "2028-02-29T10:00:00.000Z",
          }),
        ],
      })
    );

    await apply(
      "subscription.updated",
      subscriptionEvent({
        product_id: "prod_business_year",
        current_period_start: "2028-01-31T10:00:00.000000Z",
        current_period_end: "2029-01-31T10:00:00.000000Z",
      })
    );

    const payload = userUpdatePayload();
    expect(payload).toMatchObject({
      billing_period_end: "2029-01-31T10:00:00.000Z",
      period_end: "2028-02-29T10:00:00.000Z",
    });
    // The window keeps its start (Jan 28), which the parsed pages count from.
    expect(payload?.period_start).toBeUndefined();
    expect(payload).not.toHaveProperty("requests_used");
  });

  test("a yearly renewal a month after the last reset starts a fresh allowance", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          storedUser({
            plan: "business",
            billing_interval: "year",
            billing_period_end: "2028-01-31T10:00:00.000Z",
            period_start: "2027-12-31T10:00:00.000Z",
            period_end: "2028-01-31T10:00:00.000Z",
          }),
        ],
      })
    );

    await apply(
      "subscription.updated",
      subscriptionEvent({
        product_id: "prod_business_year",
        current_period_start: "2028-01-31T10:00:00.000000Z",
        current_period_end: "2029-01-31T10:00:00.000000Z",
      })
    );

    expect(userUpdatePayload()).toMatchObject({ requests_used: 0 });
  });

  test("a move to annual days after a monthly renewal still starts a fresh allowance", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          storedUser({
            plan: "business",
            billing_interval: "month",
            period_start: "2026-08-01T00:00:00.000Z",
            period_end: "2026-08-31T00:00:00.000Z",
          }),
        ],
      })
    );

    await apply(
      "subscription.updated",
      subscriptionEvent({
        product_id: "prod_business_year",
        current_period_start: "2026-08-03T00:00:00.000000Z",
        current_period_end: "2027-08-03T00:00:00.000000Z",
      })
    );

    expect(userUpdatePayload()).toMatchObject({
      period_start: "2026-08-03T00:00:00.000Z",
      period_end: "2026-09-03T00:00:00.000Z",
      requests_used: 0,
    });
  });

  test("months counted from one date keep its day through short months", () => {
    expect(addMonthsUtc("2028-01-31T10:00:00.000Z", -11)).toBe("2027-02-28T10:00:00.000Z");
    expect(addMonthsUtc("2028-01-31T10:00:00.000Z", -10)).toBe("2027-03-31T10:00:00.000Z");
    expect(addMonthsUtc("2028-01-31T10:00:00.000Z", 1)).toBe("2028-02-29T10:00:00.000Z");
    expect(addMonthsUtc("2027-01-15T00:00:00.000Z", -13)).toBe("2025-12-15T00:00:00.000Z");
  });

  test("annual windows keep the year's day and the last ends with the year", () => {
    const yearEnd = "2028-01-31T10:00:00.000Z";
    const ends: string[] = [];
    let from = "2027-01-31T10:00:00.000Z";
    for (let i = 0; i < 12; i += 1) {
      const window = annualQuotaWindow(yearEnd, from);
      expect(window.start).toBe(from);
      ends.push(window.end.slice(0, 10));
      from = window.end;
    }
    expect(ends).toEqual([
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
      "2027-07-31",
      "2027-08-31",
      "2027-09-30",
      "2027-10-31",
      "2027-11-30",
      "2027-12-31",
      "2028-01-31",
    ]);
  });

  test("an annual window holds the later of where the last ended and now", () => {
    const yearEnd = "2028-01-31T10:00:00.000Z";
    // A reset job that was down for months grants one window, holding now.
    expect(
      annualQuotaWindow(yearEnd, "2027-03-31T10:00:00.000Z", "2027-06-10T00:00:00.000Z")
    ).toEqual({ start: "2027-05-31T10:00:00.000Z", end: "2027-06-30T10:00:00.000Z" });
    // Just before a boundary in the same month belongs to the window before.
    expect(
      annualQuotaWindow(yearEnd, "2027-03-31T10:00:00.000Z", "2027-04-30T09:59:59.000Z")
    ).toEqual({ start: "2027-03-31T10:00:00.000Z", end: "2027-04-30T10:00:00.000Z" });
    // Past the year's end (a late renewal), the windows go on from it.
    expect(annualQuotaWindow(yearEnd, yearEnd, "2028-02-01T00:00:00.000Z")).toEqual({
      start: yearEnd,
      end: "2028-02-29T10:00:00.000Z",
    });
  });

  test("a window that drifted off the boundaries joins the next instead of a few days", () => {
    expect(annualQuotaWindow("2028-01-31T10:00:00.000Z", "2027-11-28T10:00:00.000Z")).toEqual({
      start: "2027-11-28T10:00:00.000Z",
      end: "2027-12-31T10:00:00.000Z",
    });
  });

  test("a month added to the 31st lands on the last day of a shorter month", () => {
    expect(addMonthUtc("2027-01-31T10:00:00.000Z")).toBe("2027-02-28T10:00:00.000Z");
    expect(addMonthUtc("2028-01-31T10:00:00.000Z")).toBe("2028-02-29T10:00:00.000Z");
    expect(addMonthUtc("2026-12-15T00:00:00.000Z")).toBe("2027-01-15T00:00:00.000Z");
  });
});

describe("a revoked plan hands over to a plan the customer still has live", () => {
  beforeEach(() => {
    vi.stubEnv("POLAR_PRO_PRODUCT_ID", "prod_pro");
    vi.stubEnv("POLAR_BUSINESS_PRODUCT_ID", "prod_business");
    vi.stubEnv("POLAR_BUSINESS_ANNUAL_PRODUCT_ID", "prod_business_year");
  });

  const revoked = { id: "sub_held", customer_id: "cus_1", status: "canceled" };

  function userUpdates(): Array<Record<string, unknown>> {
    return recorded
      .filter((call) => call.table === "users" && call.op === "update")
      .map((call) => call.payload as Record<string, unknown>);
  }

  test("the newest live plan subscription on the customer becomes the account's", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          { data: { id: "user_1" } },
          // The row after the clear.
          { data: { polar_subscription_id: null } },
          storedUser({ polar_subscription_id: null, plan: "free", period_start: null }),
        ],
      })
    );
    polarList.mockResolvedValue({
      items: [
        subscriptionEvent({
          id: "sub_older",
          product_id: "prod_pro",
          started_at: "2026-02-01T10:00:00Z",
        }),
        subscriptionEvent({
          id: "sub_annual",
          product_id: "prod_business_year",
          started_at: "2026-06-01T10:00:00Z",
          current_period_start: "2026-06-01T10:00:00Z",
          current_period_end: "2027-06-01T10:00:00Z",
        }),
        // Not a plan, another customer's, or ended: never adopted.
        subscriptionEvent({ id: "sub_addon", product_id: "prod_addon" }),
        subscriptionEvent({ id: "sub_foreign", product_id: "prod_pro", customer_id: "cus_2" }),
        subscriptionEvent({
          id: "sub_ended",
          product_id: "prod_pro",
          started_at: "2026-10-01T10:00:00Z",
          ended_at: "2026-10-02T10:00:00Z",
        }),
        // The revoked one itself, should Polar still list it.
        subscriptionEvent({ id: "sub_held", product_id: "prod_pro" }),
      ],
    });

    await applyPolarWebhookEvent("subscription.revoked", revoked);

    expect(polarList).toHaveBeenCalledWith({
      customer_id: "cus_1",
      product_id: ["prod_pro", "prod_business", "prod_business_year"],
      status: ["active", "trialing", "past_due"],
      limit: 100,
    });
    const [cleared, adopted] = userUpdates();
    expect(cleared).toMatchObject({ plan: "free", polar_subscription_id: null });
    expect(adopted).toMatchObject({
      plan: "business",
      billing_interval: "year",
      polar_subscription_id: "sub_annual",
    });
    // The older one stays live beside it: a person decides.
    expect(mockFns.reportError).toHaveBeenCalledTimes(1);
    expect(mockFns.reportError.mock.calls[0][2]).toEqual({
      userId: "user_1",
      adoptedSubscriptionId: "sub_annual",
      otherSubscriptionIds: ["sub_older"],
    });
    expect(polarRevoke).not.toHaveBeenCalled();
    expect(mockFns.recordRefund).not.toHaveBeenCalled();
    // Audited with ids only.
    expect(mockFns.auditSystemEvent).toHaveBeenCalledWith({
      action: "billing.plan_adopted",
      outcome: "ok",
      userId: "user_1",
      targetId: "sub_annual",
      metadata: { ended_subscription_id: "sub_held" },
    });
  });

  test("a live plan already recorded for a refund is never adopted, and is reported", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          { data: { id: "user_1" } },
          { data: { polar_subscription_id: null } },
          storedUser({ polar_subscription_id: null, plan: "free", period_start: null }),
        ],
        // The newest is a second plan whose revoke failed after its refund was recorded.
        "polar_refunds:select": [{ data: [{ target: "subscription:sub_newest" }] }],
      })
    );
    polarList.mockResolvedValue({
      items: [
        subscriptionEvent({
          id: "sub_newest",
          product_id: "prod_pro",
          started_at: "2026-06-02T10:00:00Z",
        }),
        subscriptionEvent({
          id: "sub_kept",
          product_id: "prod_pro",
          started_at: "2026-06-01T10:00:00Z",
          current_period_start: "2026-06-01T10:00:00Z",
          current_period_end: "2026-07-01T10:00:00Z",
        }),
      ],
    });

    await applyPolarWebhookEvent("subscription.revoked", revoked);

    const [, adopted] = userUpdates();
    expect(adopted).toMatchObject({ plan: "pro", polar_subscription_id: "sub_kept" });
    expect(mockFns.reportError).toHaveBeenCalledTimes(1);
    expect(mockFns.reportError.mock.calls[0][2]).toEqual({
      userId: "user_1",
      endedSubscriptionId: "sub_held",
      subscriptionIds: ["sub_newest"],
    });
  });

  test("a live plan adoption skipped for its refund is not applied by its own later event", async () => {
    // The account holds no plan (adoption skipped the refunded one), and the
    // skipped subscription's renewal, or the redelivery of the event whose
    // revoke failed, arrives with no stored id to guard on.
    for (const event of ["subscription.updated", "subscription.created"] as const) {
      recorded = [];
      mockFns.reportError.mockClear();
      mockFns.auditSystemEvent.mockClear();
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "users:select": [storedUser({ polar_subscription_id: null, plan: "free" })],
          "polar_refunds:select": [{ data: [{ target: "subscription:sub_newest" }] }],
          // The audit log holds no report of it yet.
          "audit_events:select": [{ data: [] }],
        })
      );

      await applyPolarWebhookEvent(
        event,
        subscriptionEvent({ id: "sub_newest", product_id: "prod_pro" })
      );

      const refundRead = recorded.find(
        (call) => call.table === "polar_refunds" && call.op === "select"
      );
      expect(refundRead?.filters).toContainEqual(["neq", "status", "dismissed"]);
      expect(userUpdates()).toHaveLength(0);
      expect(polarRevoke).not.toHaveBeenCalled();
      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(mockFns.reportError).toHaveBeenCalledTimes(1);
      // The report says how a person keeps it.
      expect(mockFns.reportError.mock.calls[0][0]).toContain("dismiss its held refund");
      expect(mockFns.reportError.mock.calls[0][2]).toEqual({
        userId: "user_1",
        storedSubscriptionId: null,
        eventSubscriptionId: "sub_newest",
        reason: "refund_recorded",
      });
      // Audited with ids only, looked up by subscription and reason first.
      const auditRead = recorded.find(
        (call) => call.table === "audit_events" && call.op === "select"
      );
      expect(auditRead?.filters).toContainEqual(["eq", "target_id", "sub_newest"]);
      expect(auditRead?.filters).toContainEqual(["eq", "metadata->>reason", "refund_recorded"]);
      expect(mockFns.auditSystemEvent).toHaveBeenCalledTimes(1);
      expect(mockFns.auditSystemEvent).toHaveBeenCalledWith({
        action: "billing.duplicate_plan_reported",
        outcome: "refused",
        userId: "user_1",
        targetId: "sub_newest",
        metadata: { stored_subscription_id: null, reason: "refund_recorded" },
      });
    }
  });

  test("a refunded plan's later event already audited is reported without a second audit row", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ polar_subscription_id: null, plan: "free" })],
        "polar_refunds:select": [{ data: [{ target: "subscription:sub_newest" }] }],
        "audit_events:select": [{ data: [{ id: "audit_1" }] }],
      })
    );

    await applyPolarWebhookEvent(
      "subscription.updated",
      subscriptionEvent({ id: "sub_newest", product_id: "prod_pro" })
    );

    expect(userUpdates()).toHaveLength(0);
    expect(mockFns.reportError).toHaveBeenCalledTimes(1);
    expect(mockFns.auditSystemEvent).not.toHaveBeenCalled();
  });

  test("the held subscription's own renewal is written without a refund check", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ polar_subscription_id: "sub_1" })],
        // Would refuse it, were it read: the guard is for new subscriptions only.
        "polar_refunds:select": [{ data: [{ target: "subscription:sub_1" }] }],
      })
    );

    await applyPolarWebhookEvent(
      "subscription.updated",
      subscriptionEvent({ id: "sub_1", product_id: "prod_pro" })
    );

    expect(
      recorded.filter((call) => call.table === "polar_refunds" && call.op === "select")
    ).toHaveLength(0);
    expect(userUpdates()).toHaveLength(1);
    expect(userUpdates()[0]).toMatchObject({
      polar_subscription_id: "sub_1",
      plan: "pro",
      requests_used: 0,
      period_start: "2026-08-01T00:00:00.000Z",
    });
    expect(mockFns.reportError).not.toHaveBeenCalled();
  });

  test("a new plan subscription with no refund recorded is applied after the refund check", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ polar_subscription_id: null, plan: "free" })],
        "polar_refunds:select": [{ data: [] }],
      })
    );

    await applyPolarWebhookEvent(
      "subscription.created",
      subscriptionEvent({ id: "sub_new", product_id: "prod_pro" })
    );

    expect(userUpdates()).toHaveLength(1);
    expect(userUpdates()[0]).toMatchObject({ plan: "pro", polar_subscription_id: "sub_new" });
    expect(mockFns.reportError).not.toHaveBeenCalled();
  });

  test("a live plan whose refund a person dismissed is adopted", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          { data: { id: "user_1" } },
          { data: { polar_subscription_id: null } },
          storedUser({ polar_subscription_id: null, plan: "free", period_start: null }),
        ],
        // The database leaves the dismissed row out of the answer.
        "polar_refunds:select": [{ data: [] }],
      })
    );
    polarList.mockResolvedValue({
      items: [
        subscriptionEvent({
          id: "sub_dismissed",
          product_id: "prod_pro",
          started_at: "2026-06-01T10:00:00Z",
          current_period_start: "2026-06-01T10:00:00Z",
          current_period_end: "2026-07-01T10:00:00Z",
        }),
      ],
    });

    await applyPolarWebhookEvent("subscription.revoked", revoked);

    const refundRead = recorded.find(
      (call) => call.table === "polar_refunds" && call.op === "select"
    );
    expect(refundRead?.filters).toContainEqual(["neq", "status", "dismissed"]);
    const [, adopted] = userUpdates();
    expect(adopted).toMatchObject({ plan: "pro", polar_subscription_id: "sub_dismissed" });
    expect(mockFns.reportError).not.toHaveBeenCalled();
  });

  test("with only a refunded live plan left the account stays free", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [{ data: { id: "user_1" } }, { data: { polar_subscription_id: null } }],
        "polar_refunds:select": [{ data: [{ target: "subscription:sub_newest" }] }],
      })
    );
    polarList.mockResolvedValue({
      items: [subscriptionEvent({ id: "sub_newest", product_id: "prod_pro" })],
    });

    await applyPolarWebhookEvent("subscription.revoked", revoked);

    expect(userUpdates()).toHaveLength(1);
    expect(userUpdates()[0]).toMatchObject({ plan: "free", polar_subscription_id: null });
    expect(mockFns.auditSystemEvent).not.toHaveBeenCalled();
  });

  test("with no other live plan the account stays free", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [{ data: { id: "user_1" } }, { data: { polar_subscription_id: null } }],
      })
    );

    await applyPolarWebhookEvent("subscription.revoked", revoked);

    expect(polarList).toHaveBeenCalledTimes(1);
    expect(userUpdates()).toHaveLength(1);
    expect(userUpdates()[0]).toMatchObject({ plan: "free", polar_subscription_id: null });
    expect(mockFns.reportError).not.toHaveBeenCalled();
  });

  test("an account that holds another subscription is left alone", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [
          { data: { id: "user_1" } },
          { data: { polar_subscription_id: "sub_other" } },
        ],
        // The clear matched no row: the event was not for the held plan.
        "users:update": [{ data: [] }],
      })
    );

    await applyPolarWebhookEvent("subscription.revoked", revoked);

    expect(polarList).not.toHaveBeenCalled();
    expect(userUpdates()).toHaveLength(1);
  });

  test("a failed list throws, so the route skips the add-on reconcile and Polar redelivers", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [{ data: { id: "user_1" } }, { data: { polar_subscription_id: null } }],
      })
    );
    polarList.mockRejectedValue(new Error("Polar unavailable"));

    await expect(applyPolarWebhookEvent("subscription.revoked", revoked)).rejects.toThrow(
      "Polar unavailable"
    );
    // The row is free, as it was before adoption existed; nothing else changed.
    expect(userUpdates()).toHaveLength(1);
    expect(userUpdates()[0]).toMatchObject({ plan: "free" });
    expect(polarRevoke).not.toHaveBeenCalled();
  });
});
