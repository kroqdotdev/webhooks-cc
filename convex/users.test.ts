import { convexTest } from "convex-test";
import { describe, test, expect, beforeEach } from "vitest";
import { modules } from "./test.setup";
import schema from "./schema";
import { internal } from "./_generated/api";
import { FREE_REQUEST_LIMIT, PRO_REQUEST_LIMIT, BILLING_PERIOD_MS } from "./config";

describe("resetFreeUserPeriod", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("clears periodEnd and resets requestsUsed for free user", async () => {
    const now = Date.now();
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {
        email: "free@example.com",
        plan: "free" as const,
        requestsUsed: 150,
        requestLimit: FREE_REQUEST_LIMIT,
        periodStart: now - 86400000,
        periodEnd: now,
        createdAt: now - 86400000,
      });
    });

    await t.mutation(internal.users.resetFreeUserPeriod, { userId });
    // Wait for scheduled cleanupUserRequests to finish (avoids unhandled rejection)
    await t.finishInProgressScheduledFunctions();

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.periodEnd).toBeUndefined();
    expect(user!.requestsUsed).toBe(0);
  });

  test("no-op for pro users", async () => {
    const now = Date.now();
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {
        email: "pro@example.com",
        plan: "pro" as const,
        requestsUsed: 5000,
        requestLimit: PRO_REQUEST_LIMIT,
        periodStart: now,
        periodEnd: now + BILLING_PERIOD_MS,
        polarCustomerId: "polar_cust_123",
        polarSubscriptionId: "polar_sub_123",
        subscriptionStatus: "active" as const,
        cancelAtPeriodEnd: false,
        createdAt: now,
      });
    });

    await t.mutation(internal.users.resetFreeUserPeriod, { userId });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    // Pro user should be unchanged
    expect(user!.requestsUsed).toBe(5000);
    expect(user!.periodEnd).toBe(now + BILLING_PERIOD_MS);
  });

  test("no-op for nonexistent user", async () => {
    // Create and delete to get a valid-format but nonexistent ID
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {
        email: "gone@example.com",
        plan: "free" as const,
        requestsUsed: 0,
        requestLimit: FREE_REQUEST_LIMIT,
        createdAt: Date.now(),
      });
    });
    await t.run(async (ctx) => ctx.db.delete(userId));

    // Should not throw
    await t.mutation(internal.users.resetFreeUserPeriod, { userId });
  });

  test("schedules cleanup of user requests via cleanupUserRequests", async () => {
    const now = Date.now();
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {
        email: "cleanup@example.com",
        plan: "free" as const,
        requestsUsed: 0,
        requestLimit: FREE_REQUEST_LIMIT,
        createdAt: now - 86400000,
      });
    });

    // Create an endpoint and some requests for this user
    const endpointId = await t.run(async (ctx) => {
      return await ctx.db.insert("endpoints", {
        slug: "cleanup-test",
        userId,
        isEphemeral: false,
        createdAt: now,
      });
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("requests", {
        endpointId,
        method: "POST",
        path: "/w/cleanup-test",
        headers: {},
        queryParams: {},
        ip: "127.0.0.1",
        size: 0,
        receivedAt: now - 1000,
      });
    });

    // Verify requests exist before cleanup
    const before = await t.run(async (ctx) => {
      return await ctx.db.query("requests").collect();
    });
    expect(before).toHaveLength(1);

    // Call cleanupUserRequests directly (resetFreeUserPeriod schedules this via runAfter(0))
    await t.mutation(internal.requests.cleanupUserRequests, { userId });

    const after = await t.run(async (ctx) => {
      return await ctx.db.query("requests").collect();
    });
    expect(after).toHaveLength(0);
  });
});
