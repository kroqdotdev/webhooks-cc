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

  test("does not delete user requests on period reset", async () => {
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

    await t.mutation(internal.users.resetFreeUserPeriod, { userId });

    const after = await t.run(async (ctx) => {
      return await ctx.db.query("requests").collect();
    });
    expect(after).toHaveLength(1);
  });
});

describe("plan queries", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("getPlanById returns current plan and null for missing user", async () => {
    const freeUserId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {
        email: "plan-free@example.com",
        plan: "free" as const,
        requestsUsed: 0,
        requestLimit: FREE_REQUEST_LIMIT,
        createdAt: Date.now(),
      });
    });

    const freePlan = await t.query(internal.users.getPlanById, { userId: freeUserId });
    expect(freePlan).toBe("free");

    await t.run(async (ctx) => ctx.db.delete(freeUserId));
    const missingPlan = await t.query(internal.users.getPlanById, { userId: freeUserId });
    expect(missingPlan).toBeNull();
  });

  test("listByPlanPaginated filters users by plan across pages", async () => {
    const freeUserIds: string[] = [];
    const proUserIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const id = await t.run(async (ctx) => {
        return await ctx.db.insert("users", {
          email: `plan-free-${i}@example.com`,
          plan: "free" as const,
          requestsUsed: 0,
          requestLimit: FREE_REQUEST_LIMIT,
          createdAt: Date.now() + i,
        });
      });
      freeUserIds.push(String(id));
    }

    for (let i = 0; i < 2; i++) {
      const id = await t.run(async (ctx) => {
        return await ctx.db.insert("users", {
          email: `plan-pro-${i}@example.com`,
          plan: "pro" as const,
          requestsUsed: 0,
          requestLimit: PRO_REQUEST_LIMIT,
          periodStart: Date.now(),
          periodEnd: Date.now() + BILLING_PERIOD_MS,
          polarCustomerId: `polar_cust_${i}`,
          polarSubscriptionId: `polar_sub_${i}`,
          subscriptionStatus: "active" as const,
          cancelAtPeriodEnd: false,
          createdAt: Date.now() + i,
        });
      });
      proUserIds.push(String(id));
    }

    const freePage1 = await t.query(internal.users.listByPlanPaginated, {
      plan: "free",
      limit: 2,
    });
    expect(freePage1.userIds).toHaveLength(2);
    expect(freePage1.done).toBe(false);
    expect(freePage1.nextCursor).toBeTruthy();
    for (const id of freePage1.userIds) {
      expect(freeUserIds).toContain(id);
      expect(proUserIds).not.toContain(id);
    }

    const freePage2 = await t.query(internal.users.listByPlanPaginated, {
      plan: "free",
      limit: 2,
      cursor: freePage1.nextCursor ?? undefined,
    });
    expect(freePage2.done).toBe(true);
    const allFree = [...freePage1.userIds, ...freePage2.userIds];
    expect(new Set(allFree).size).toBe(3);
    for (const id of allFree) {
      expect(freeUserIds).toContain(id);
      expect(proUserIds).not.toContain(id);
    }

    const proPage = await t.query(internal.users.listByPlanPaginated, {
      plan: "pro",
      limit: 10,
    });
    expect(proPage.done).toBe(true);
    expect(new Set(proPage.userIds).size).toBe(2);
    for (const id of proPage.userIds) {
      expect(proUserIds).toContain(id);
      expect(freeUserIds).not.toContain(id);
    }
  });
});
