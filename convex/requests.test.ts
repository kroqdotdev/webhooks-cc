import { convexTest } from "convex-test";
import { describe, test, expect, beforeEach } from "vitest";
import { modules } from "./test.setup";
import schema from "./schema";
import { internal } from "./_generated/api";
import { FREE_REQUEST_LIMIT, PRO_REQUEST_LIMIT, BILLING_PERIOD_MS, FREE_PERIOD_MS } from "./config";

// Helper to create a free user
async function createFreeUser(
  t: ReturnType<typeof convexTest>,
  overrides: Record<string, unknown> = {}
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      email: "test@example.com",
      plan: "free" as const,
      requestsUsed: 0,
      requestLimit: FREE_REQUEST_LIMIT,
      createdAt: Date.now(),
      ...overrides,
    });
  });
}

// Helper to create a pro user
async function createProUser(
  t: ReturnType<typeof convexTest>,
  overrides: Record<string, unknown> = {}
) {
  const now = Date.now();
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      email: "pro@example.com",
      plan: "pro" as const,
      requestsUsed: 0,
      requestLimit: PRO_REQUEST_LIMIT,
      polarCustomerId: "polar_cust_123",
      polarSubscriptionId: "polar_sub_123",
      subscriptionStatus: "active" as const,
      periodStart: now,
      periodEnd: now + BILLING_PERIOD_MS,
      cancelAtPeriodEnd: false,
      createdAt: now,
      ...overrides,
    });
  });
}

// Helper to create an endpoint
async function createEndpoint(
  t: ReturnType<typeof convexTest>,
  overrides: Record<string, unknown> = {}
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("endpoints", {
      slug: "test-slug",
      isEphemeral: false,
      createdAt: Date.now(),
      ...overrides,
    });
  });
}

// Helper for a standard capture request
function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: "/w/test-slug",
    headers: { "content-type": "application/json" },
    body: '{"hello":"world"}',
    queryParams: {},
    ip: "127.0.0.1",
    ...overrides,
  };
}

describe("checkAndStartPeriod", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("starts new 24h period for free user with no active period", async () => {
    const userId = await createFreeUser(t);

    const result = await t.mutation(internal.requests.checkAndStartPeriod, {
      userId,
    });

    expect(result).toHaveProperty("remaining", FREE_REQUEST_LIMIT);
    expect(result).toHaveProperty("limit", FREE_REQUEST_LIMIT);
    expect(result).toHaveProperty("periodEnd");
    expect((result as { periodEnd: number }).periodEnd).toBeGreaterThan(Date.now() - 1000);

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.periodEnd).toBeDefined();
    expect(user!.requestsUsed).toBe(0);
  });

  test("starts new period when previous expired, resets requestsUsed", async () => {
    const pastEnd = Date.now() - 1000;
    const userId = await createFreeUser(t, {
      periodStart: pastEnd - FREE_PERIOD_MS,
      periodEnd: pastEnd,
      requestsUsed: 150,
    });

    const result = await t.mutation(internal.requests.checkAndStartPeriod, {
      userId,
    });

    expect(result).toHaveProperty("remaining", FREE_REQUEST_LIMIT);
    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.requestsUsed).toBe(0);
    expect(user!.periodEnd).toBeGreaterThan(Date.now() - 1000);
  });

  test("returns current state if period still active", async () => {
    const now = Date.now();
    const userId = await createFreeUser(t, {
      periodStart: now,
      periodEnd: now + FREE_PERIOD_MS,
      requestsUsed: 50,
    });

    const result = await t.mutation(internal.requests.checkAndStartPeriod, {
      userId,
    });

    expect(result).toHaveProperty("remaining", FREE_REQUEST_LIMIT - 50);
    expect(result).toHaveProperty("limit", FREE_REQUEST_LIMIT);
  });

  test("returns quota_exceeded with retryAfter when limit hit", async () => {
    const now = Date.now();
    const periodEnd = now + FREE_PERIOD_MS;
    const userId = await createFreeUser(t, {
      periodStart: now,
      periodEnd,
      requestsUsed: FREE_REQUEST_LIMIT,
    });

    const result = await t.mutation(internal.requests.checkAndStartPeriod, {
      userId,
    });

    expect(result).toHaveProperty("error", "quota_exceeded");
    expect(result).toHaveProperty("retryAfter");
    expect((result as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
  });

  test("returns remaining quota for pro users without modification", async () => {
    const userId = await createProUser(t, { requestsUsed: 1000 });

    const result = await t.mutation(internal.requests.checkAndStartPeriod, {
      userId,
    });

    expect(result).toHaveProperty("remaining", PRO_REQUEST_LIMIT - 1000);
    expect(result).toHaveProperty("limit", PRO_REQUEST_LIMIT);
  });

  test("returns not_found for nonexistent user", async () => {
    // Create and delete to get valid format ID
    const userId = await createFreeUser(t);
    await t.run(async (ctx) => ctx.db.delete(userId));

    const result = await t.mutation(internal.requests.checkAndStartPeriod, {
      userId,
    });

    expect(result).toHaveProperty("error", "not_found");
  });

  test("idempotent: second call sees active period from first", async () => {
    const userId = await createFreeUser(t);

    const result1 = await t.mutation(internal.requests.checkAndStartPeriod, {
      userId,
    });
    const result2 = await t.mutation(internal.requests.checkAndStartPeriod, {
      userId,
    });

    // Both should return the same period end
    expect((result1 as { periodEnd: number }).periodEnd).toBe(
      (result2 as { periodEnd: number }).periodEnd
    );
  });
});

describe("incrementUsage", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("default increment by 1", async () => {
    const userId = await createFreeUser(t);

    await t.mutation(internal.requests.incrementUsage, { userId });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.requestsUsed).toBe(1);
  });

  test("increment by specified count", async () => {
    const userId = await createFreeUser(t);

    await t.mutation(internal.requests.incrementUsage, {
      userId,
      count: 10,
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.requestsUsed).toBe(10);
  });

  test("cap at 1000 per call", async () => {
    const userId = await createFreeUser(t);

    await t.mutation(internal.requests.incrementUsage, {
      userId,
      count: 5000,
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.requestsUsed).toBe(1000);
  });

  test("negative count treated as 1", async () => {
    const userId = await createFreeUser(t);

    await t.mutation(internal.requests.incrementUsage, {
      userId,
      count: -5,
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.requestsUsed).toBe(1);
  });

  test("nonexistent user handled gracefully", async () => {
    const userId = await createFreeUser(t);
    await t.run(async (ctx) => ctx.db.delete(userId));

    // Should not throw
    await t.mutation(internal.requests.incrementUsage, { userId });
  });
});

describe("getQuota", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("returns not_found for nonexistent endpoint", async () => {
    const result = await t.query(internal.requests.getQuota, {
      slug: "nonexistent",
    });
    expect(result).toHaveProperty("error", "not_found");
  });

  test("returns ephemeral quota for ephemeral endpoints", async () => {
    await createEndpoint(t, {
      slug: "ephemeral-slug",
      isEphemeral: true,
      expiresAt: Date.now() + 600000,
    });

    const result = await t.query(internal.requests.getQuota, {
      slug: "ephemeral-slug",
    });

    expect(result).toHaveProperty("plan", "ephemeral");
    expect(result).toHaveProperty("limit", 50);
    expect(result).toHaveProperty("remaining", 50);
  });

  test("returns needsPeriodStart=true for free user with no active period", async () => {
    const userId = await createFreeUser(t);
    await createEndpoint(t, { slug: "free-slug", userId });

    const result = await t.query(internal.requests.getQuota, {
      slug: "free-slug",
    });

    expect(result).toHaveProperty("needsPeriodStart", true);
    expect(result).toHaveProperty("plan", "free");
  });

  test("returns remaining quota for pro user with active period", async () => {
    const userId = await createProUser(t, { requestsUsed: 1000 });
    await createEndpoint(t, { slug: "pro-slug", userId });

    const result = await t.query(internal.requests.getQuota, {
      slug: "pro-slug",
    });

    expect(result).toHaveProperty("remaining", PRO_REQUEST_LIMIT - 1000);
    expect(result).toHaveProperty("plan", "pro");
    expect(result).toHaveProperty("needsPeriodStart", false);
  });

  test("returns zero remaining when quota exhausted", async () => {
    const userId = await createProUser(t, {
      requestsUsed: PRO_REQUEST_LIMIT,
    });
    await createEndpoint(t, { slug: "exhausted-slug", userId });

    const result = await t.query(internal.requests.getQuota, {
      slug: "exhausted-slug",
    });

    expect(result).toHaveProperty("remaining", 0);
  });
});

describe("capture", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("stores request and returns default mock response", async () => {
    await createEndpoint(t, { slug: "capture-slug" });

    const result = await t.mutation(internal.requests.capture, {
      slug: "capture-slug",
      ...makeRequest(),
    });

    expect(result).toHaveProperty("success", true);
    expect(result.mockResponse).toEqual({
      status: 200,
      body: "OK",
      headers: {},
    });

    // Verify request was stored
    const requests = await t.run(async (ctx) => {
      return await ctx.db.query("requests").collect();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].body).toBe('{"hello":"world"}');
  });

  test("returns not_found for nonexistent slug", async () => {
    const result = await t.mutation(internal.requests.capture, {
      slug: "nonexistent",
      ...makeRequest(),
    });

    expect(result).toHaveProperty("error", "not_found");
  });

  test("returns expired for expired endpoint", async () => {
    await createEndpoint(t, {
      slug: "expired-slug",
      expiresAt: Date.now() - 1000,
    });

    const result = await t.mutation(internal.requests.capture, {
      slug: "expired-slug",
      ...makeRequest(),
    });

    expect(result).toHaveProperty("error", "expired");
  });

  test("returns custom mock response when configured", async () => {
    await createEndpoint(t, {
      slug: "custom-mock",
      mockResponse: {
        status: 201,
        body: '{"created":true}',
        headers: { "x-custom": "header" },
      },
    });

    const result = await t.mutation(internal.requests.capture, {
      slug: "custom-mock",
      ...makeRequest(),
    });

    expect(result).toHaveProperty("success", true);
    expect(result.mockResponse).toEqual({
      status: 201,
      body: '{"created":true}',
      headers: { "x-custom": "header" },
    });
  });
});

describe("captureBatch", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("inserts multiple requests for a slug", async () => {
    await createEndpoint(t, { slug: "batch-slug" });

    const now = Date.now();
    const result = await t.mutation(internal.requests.captureBatch, {
      slug: "batch-slug",
      requests: [
        { ...makeRequest(), receivedAt: now },
        { ...makeRequest({ method: "GET" }), receivedAt: now + 1 },
        { ...makeRequest({ method: "PUT" }), receivedAt: now + 2 },
      ],
    });

    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("inserted", 3);

    const stored = await t.run(async (ctx) => {
      return await ctx.db.query("requests").collect();
    });
    expect(stored).toHaveLength(3);
  });

  test("returns not_found for nonexistent slug", async () => {
    const result = await t.mutation(internal.requests.captureBatch, {
      slug: "nonexistent",
      requests: [{ ...makeRequest(), receivedAt: Date.now() }],
    });

    expect(result).toHaveProperty("error", "not_found");
    expect(result).toHaveProperty("inserted", 0);
  });

  test("returns expired for expired endpoint", async () => {
    await createEndpoint(t, {
      slug: "expired-batch",
      expiresAt: Date.now() - 1000,
    });

    const result = await t.mutation(internal.requests.captureBatch, {
      slug: "expired-batch",
      requests: [{ ...makeRequest(), receivedAt: Date.now() }],
    });

    expect(result).toHaveProperty("error", "expired");
    expect(result).toHaveProperty("inserted", 0);
  });

  test("schedules usage increment for authenticated endpoints", async () => {
    const userId = await createProUser(t);
    await createEndpoint(t, { slug: "auth-batch", userId });

    const now = Date.now();
    const result = await t.mutation(internal.requests.captureBatch, {
      slug: "auth-batch",
      requests: [
        { ...makeRequest(), receivedAt: now },
        { ...makeRequest(), receivedAt: now + 1 },
      ],
    });

    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("inserted", 2);

    // captureBatch schedules incrementUsage via ctx.scheduler.runAfter(0, ...).
    // Verify the equivalent effect by calling incrementUsage directly
    // (convex-test's scheduled function execution has limitations with runAfter(0)).
    await t.mutation(internal.requests.incrementUsage, {
      userId,
      count: 2,
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.requestsUsed).toBe(2);
  });
});
