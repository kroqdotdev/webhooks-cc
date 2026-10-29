import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  createPolarClient: vi.fn(),
  getPolarCheckoutConfig: vi.fn(),
  reconcileAddonsWithPlan: vi.fn(),
}));

vi.mock("@/lib/polar", async (importOriginal) => ({
  // The real product matching reads the product env vars set in each test.
  planForProduct: (await importOriginal<typeof import("@/lib/polar")>()).planForProduct,
  planProductId: (await importOriginal<typeof import("@/lib/polar")>()).planProductId,
  createPolarClient: mockFns.createPolarClient,
  getPolarCheckoutConfig: mockFns.getPolarCheckoutConfig,
  unwrapPolarResult: <T>(result: T) => result,
}));

vi.mock("./capacity-billing", () => ({
  reconcileAddonsWithPlan: mockFns.reconcileAddonsWithPlan,
}));

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

import {
  addMonthUtc,
  applyPolarWebhookEvent,
  changePlanForUser,
  keepCurrentPlanForUser,
  remainingShare,
} from "./billing";

// Plan events apply the subscription as Polar has it now: by default the
// event's own payload, or what a test puts here.
let polarSubscriptions: Record<string, Record<string, unknown>> = {};
const polarRevoke = vi.fn();

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

      for (const method of ["eq", "is"] as const) {
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
    },
  });
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

  test("no-ops for a user row that no longer exists", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [{ data: null }] })
    );

    await apply("subscription.updated", subscriptionEvent());

    expect(userUpdatePayload()).toBeUndefined();
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

  test("a second live plan subscription is revoked and reported, and the account keeps its own", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser({ polar_subscription_id: "sub_first" })] })
    );
    polarSubscriptions.sub_first = subscriptionEvent({ id: "sub_first" });

    await apply("subscription.created", subscriptionEvent({ id: "sub_second" }));

    expect(polarRevoke).toHaveBeenCalledWith("sub_second");
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

  test("a write that lost a race throws, so Polar delivers the event again", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ period_start: "2026-08-01T00:00:00.000Z" })],
        "users:update": [{ data: [] }],
      })
    );

    await expect(apply("subscription.updated", subscriptionEvent())).rejects.toThrow(/retry/);
  });

  test("the pro rata share uses Polar's period and the time of the change", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-20T00:00:00.000Z"), toFake: ["Date"] });
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
    polarSubscriptions.sub_1 = subscriptionEvent({
      product_id: "prod_business",
      // Changed half way through August; delivered four days later.
      modified_at: "2026-08-16T00:00:00.000Z",
    });

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

  test("a month added to the 31st lands on the last day of a shorter month", () => {
    expect(addMonthUtc("2027-01-31T10:00:00.000Z")).toBe("2027-02-28T10:00:00.000Z");
    expect(addMonthUtc("2028-01-31T10:00:00.000Z")).toBe("2028-02-29T10:00:00.000Z");
    expect(addMonthUtc("2026-12-15T00:00:00.000Z")).toBe("2027-01-15T00:00:00.000Z");
  });
});
