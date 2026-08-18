import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  createPolarClient: vi.fn(),
  getPolarCheckoutConfig: vi.fn(),
}));

vi.mock("@/lib/polar", () => ({
  createPolarClient: mockFns.createPolarClient,
  getPolarCheckoutConfig: mockFns.getPolarCheckoutConfig,
  unwrapPolarResult: <T>(result: T) => result,
}));

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

import { applyPolarWebhookEvent } from "./billing";

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
}

let recorded: RecordedCall[] = [];

function createFakeAdmin(responses: Record<string, QueryResult[]>) {
  return {
    from(table: string) {
      let op = "select";
      let payload: unknown;

      const take = (): QueryResult => {
        const queue = responses[`${table}:${op}`];
        const next = queue?.shift();
        return { data: null, error: null, ...next };
      };

      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["eq", "is", "in", "order", "limit", "select"] as const) {
        builder[method] = chain;
      }

      for (const method of ["insert", "update", "delete"] as const) {
        builder[method] = (value?: unknown) => {
          op = method;
          payload = value;
          return builder;
        };
      }

      const settle = () => {
        recorded.push({ table, op, payload });
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
    | Record<string, unknown>
    | undefined;
}

// A personal-customer payload: extractCustomerUserId resolves the user id from
// the customer object, so no users lookup-by-customer query happens.
function subscriptionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_1",
    customerId: "cus_1",
    status: "active",
    customer: { id: "cus_1", externalId: "user_1", metadata: { userId: "user_1" } },
    currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-08-31T00:00:00Z"),
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function storedUser(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      polar_subscription_id: "sub_1",
      subscription_status: "active",
      period_start: "2026-07-01T00:00:00.000Z",
      ...overrides,
    },
  };
}

beforeEach(() => {
  recorded = [];
  vi.clearAllMocks();
});

describe("applyPolarWebhookEvent subscription.created/updated", () => {
  test("renewal (same subscription, later period start) resets usage", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [storedUser()], "users:update": [{}] })
    );

    await applyPolarWebhookEvent("subscription.updated", subscriptionEvent());

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

    await applyPolarWebhookEvent("subscription.updated", subscriptionEvent());

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

    await applyPolarWebhookEvent("subscription.updated", subscriptionEvent());

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

    await applyPolarWebhookEvent("subscription.created", subscriptionEvent());

    const payload = userUpdatePayload();
    expect(payload).toMatchObject({
      requests_used: 0,
      polar_subscription_id: "sub_1",
    });
  });

  test("an unrecognized status keeps the stored status instead of nulling it", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "users:select": [storedUser({ subscription_status: "canceled" })],
        "users:update": [{}],
      })
    );

    await applyPolarWebhookEvent(
      "subscription.updated",
      subscriptionEvent({ status: "some_future_status" })
    );

    expect(userUpdatePayload()).toMatchObject({ subscription_status: "canceled" });
  });

  test("no-ops for a user row that no longer exists", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "users:select": [{ data: null }] })
    );

    await applyPolarWebhookEvent("subscription.updated", subscriptionEvent());

    expect(userUpdatePayload()).toBeUndefined();
  });
});
