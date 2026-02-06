import { convexTest } from "convex-test";
import { describe, test, expect, beforeEach } from "vitest";
import { modules } from "./test.setup";
import schema from "./schema";
import { internal } from "./_generated/api";
import { FREE_REQUEST_LIMIT, PRO_REQUEST_LIMIT, BILLING_PERIOD_MS } from "./config";

// Helper to create a free user via t.run
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

describe("handleWebhook", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  // --- Customer events ---
  describe("customer events", () => {
    test("customer.created logs without error", async () => {
      await t.mutation(internal.billing.handleWebhook, {
        event: "customer.created",
        data: { id: "cust_abc123" },
      });
      // No error thrown = success
    });

    test("customer.updated logs without error", async () => {
      await t.mutation(internal.billing.handleWebhook, {
        event: "customer.updated",
        data: { id: "cust_abc123" },
      });
    });

    test("customer.created throws on missing id field", async () => {
      await expect(
        t.mutation(internal.billing.handleWebhook, {
          event: "customer.created",
          data: {},
        })
      ).rejects.toThrow("Missing or invalid id");
    });
  });

  // --- Order events ---
  describe("order events", () => {
    test("order.paid with valid customer_id", async () => {
      await t.mutation(internal.billing.handleWebhook, {
        event: "order.paid",
        data: { customer_id: "cust_abc123" },
      });
    });

    test("order.refunded with valid id", async () => {
      await t.mutation(internal.billing.handleWebhook, {
        event: "order.refunded",
        data: { id: "order_abc123" },
      });
    });

    test("order.paid throws on missing customer_id", async () => {
      await expect(
        t.mutation(internal.billing.handleWebhook, {
          event: "order.paid",
          data: { id: "order_abc" },
        })
      ).rejects.toThrow("Missing or invalid customer_id");
    });
  });

  // --- subscription.created ---
  describe("subscription.created", () => {
    test("upgrades free user to Pro with correct fields", async () => {
      const userId = await createFreeUser(t);
      const now = Date.now();
      const periodStart = new Date(now).toISOString();
      const periodEnd = new Date(now + BILLING_PERIOD_MS).toISOString();

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.created",
        data: {
          id: "sub_123",
          customer_id: "polar_cust_new",
          customer: { metadata: { userId } },
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
        },
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user!.plan).toBe("pro");
      expect(user!.requestLimit).toBe(PRO_REQUEST_LIMIT);
      expect(user!.polarCustomerId).toBe("polar_cust_new");
      expect(user!.polarSubscriptionId).toBe("sub_123");
      expect(user!.subscriptionStatus).toBe("active");
      expect(user!.periodStart).toBe(new Date(periodStart).getTime());
      expect(user!.periodEnd).toBe(new Date(periodEnd).getTime());
      expect(user!.cancelAtPeriodEnd).toBe(false);
    });

    test("ignores event with no userId in customer metadata", async () => {
      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.created",
        data: {
          id: "sub_123",
          customer_id: "polar_cust_orphan",
          customer: { metadata: {} },
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(Date.now() + BILLING_PERIOD_MS).toISOString(),
        },
      });
      // No error - silently ignored
    });

    test("ignores event with invalid userId format", async () => {
      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.created",
        data: {
          id: "sub_123",
          customer_id: "polar_cust_bad",
          customer: { metadata: { userId: "not-a-valid-convex-id" } },
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(Date.now() + BILLING_PERIOD_MS).toISOString(),
        },
      });
      // No error - silently ignored
    });

    test("ignores event when user does not exist", async () => {
      // Create and delete user to get a valid-format but nonexistent ID
      const userId = await createFreeUser(t);
      await t.run(async (ctx) => ctx.db.delete(userId));

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.created",
        data: {
          id: "sub_123",
          customer_id: "polar_cust_gone",
          customer: { metadata: { userId } },
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(Date.now() + BILLING_PERIOD_MS).toISOString(),
        },
      });
      // No error - silently ignored
    });

    test("returns early on invalid period dates (user stays free)", async () => {
      const userId = await createFreeUser(t);

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.created",
        data: {
          id: "sub_123",
          customer_id: "polar_cust_bad_dates",
          customer: { metadata: { userId } },
          current_period_start: "not-a-date",
          current_period_end: "also-not-a-date",
        },
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user!.plan).toBe("free");
    });

    test("throws on missing required id field", async () => {
      await expect(
        t.mutation(internal.billing.handleWebhook, {
          event: "subscription.created",
          data: {
            customer_id: "polar_cust_123",
            customer: { metadata: { userId: "fake" } },
          },
        })
      ).rejects.toThrow("Missing or invalid id");
    });
  });

  // --- subscription.updated ---
  describe("subscription.updated", () => {
    test("updates period dates on renewal", async () => {
      const userId = await createProUser(t);
      const newStart = new Date(Date.now() + BILLING_PERIOD_MS).toISOString();
      const newEnd = new Date(Date.now() + 2 * BILLING_PERIOD_MS).toISOString();

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.updated",
        data: {
          id: "polar_sub_123",
          customer_id: "polar_cust_renew",
          customer: { metadata: { userId } },
          current_period_start: newStart,
          current_period_end: newEnd,
          cancel_at_period_end: false,
        },
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user!.periodStart).toBe(new Date(newStart).getTime());
      expect(user!.periodEnd).toBe(new Date(newEnd).getTime());
    });
  });

  // --- subscription.canceled ---
  describe("subscription.canceled", () => {
    test("sets cancelAtPeriodEnd=true and status=canceled, user stays Pro", async () => {
      const userId = await createProUser(t);

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.canceled",
        data: { customer_id: "polar_cust_123" },
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user!.plan).toBe("pro");
      expect(user!.cancelAtPeriodEnd).toBe(true);
      expect(user!.subscriptionStatus).toBe("canceled");
    });

    test("handles unknown customer_id gracefully", async () => {
      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.canceled",
        data: { customer_id: "nonexistent_customer" },
      });
      // No error - user not found so nothing happens
    });

    test("throws on missing customer_id", async () => {
      await expect(
        t.mutation(internal.billing.handleWebhook, {
          event: "subscription.canceled",
          data: {},
        })
      ).rejects.toThrow("Missing or invalid customer_id");
    });
  });

  // --- subscription.uncanceled ---
  describe("subscription.uncanceled", () => {
    test("reverses cancellation", async () => {
      const userId = await createProUser(t, {
        cancelAtPeriodEnd: true,
        subscriptionStatus: "canceled" as const,
      });

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.uncanceled",
        data: { customer_id: "polar_cust_123" },
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user!.cancelAtPeriodEnd).toBe(false);
      expect(user!.subscriptionStatus).toBe("active");
    });
  });

  // --- subscription.revoked ---
  describe("subscription.revoked", () => {
    test("immediate downgrade to free tier", async () => {
      const userId = await createProUser(t);

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.revoked",
        data: { customer_id: "polar_cust_123" },
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user!.plan).toBe("free");
      expect(user!.requestLimit).toBe(FREE_REQUEST_LIMIT);
      expect(user!.requestsUsed).toBe(0);
      expect(user!.cancelAtPeriodEnd).toBe(false);
      expect(user!.periodStart).toBeUndefined();
      expect(user!.periodEnd).toBeUndefined();
      expect(user!.polarSubscriptionId).toBeUndefined();
      expect(user!.subscriptionStatus).toBeUndefined();
    });
  });

  // --- subscription.active ---
  describe("subscription.active", () => {
    test("sets subscriptionStatus to active", async () => {
      const userId = await createProUser(t, {
        subscriptionStatus: "past_due" as const,
      });

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.active",
        data: { customer_id: "polar_cust_123" },
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user!.subscriptionStatus).toBe("active");
    });
  });

  // --- Edge cases ---
  describe("edge cases", () => {
    test("null data payload handled gracefully", async () => {
      // null is technically "object" but we guard against it
      await t.mutation(internal.billing.handleWebhook, {
        event: "some.event",
        data: null,
      });
      // Returns early without error
    });

    test("unknown event type handled gracefully", async () => {
      await t.mutation(internal.billing.handleWebhook, {
        event: "totally.unknown.event",
        data: { foo: "bar" },
      });
      // Falls through to default case, no error
    });

    test("idempotent: calling subscription.created twice produces same result", async () => {
      const userId = await createFreeUser(t);
      const now = Date.now();
      const webhookData = {
        id: "sub_idem",
        customer_id: "polar_cust_idem",
        customer: { metadata: { userId } },
        current_period_start: new Date(now).toISOString(),
        current_period_end: new Date(now + BILLING_PERIOD_MS).toISOString(),
        cancel_at_period_end: false,
      };

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.created",
        data: webhookData,
      });

      await t.mutation(internal.billing.handleWebhook, {
        event: "subscription.created",
        data: webhookData,
      });

      const user = await t.run(async (ctx) => ctx.db.get(userId));
      expect(user!.plan).toBe("pro");
      expect(user!.polarSubscriptionId).toBe("sub_idem");
    });
  });
});

describe("checkPeriodResets", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("renews active pro user: resets requestsUsed, advances period", async () => {
    const pastEnd = Date.now() - 1000;
    const pastStart = pastEnd - BILLING_PERIOD_MS;
    const userId = await createProUser(t, {
      periodStart: pastStart,
      periodEnd: pastEnd,
      requestsUsed: 42000,
    });

    const result = await t.mutation(internal.billing.checkPeriodResets, {});
    expect(result.processed).toBe(1);

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.requestsUsed).toBe(0);
    expect(user!.periodStart).toBe(pastEnd);
    expect(user!.periodEnd).toBe(pastEnd + BILLING_PERIOD_MS);
  });

  test("downgrades pro user with cancelAtPeriodEnd=true to free tier", async () => {
    const pastEnd = Date.now() - 1000;
    const userId = await createProUser(t, {
      periodEnd: pastEnd,
      cancelAtPeriodEnd: true,
    });

    const result = await t.mutation(internal.billing.checkPeriodResets, {});
    expect(result.processed).toBe(1);

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.plan).toBe("free");
    expect(user!.requestLimit).toBe(FREE_REQUEST_LIMIT);
    expect(user!.requestsUsed).toBe(0);
    expect(user!.cancelAtPeriodEnd).toBe(false);
    expect(user!.periodStart).toBeUndefined();
    expect(user!.periodEnd).toBeUndefined();
    expect(user!.polarSubscriptionId).toBeUndefined();
  });

  test("skips free users (processed count = 0)", async () => {
    const pastEnd = Date.now() - 1000;
    await createFreeUser(t, {
      periodEnd: pastEnd,
    });

    const result = await t.mutation(internal.billing.checkPeriodResets, {});
    expect(result.processed).toBe(0);
  });

  test("skips users whose period has not ended yet", async () => {
    const futureEnd = Date.now() + BILLING_PERIOD_MS;
    await createProUser(t, {
      periodEnd: futureEnd,
    });

    const result = await t.mutation(internal.billing.checkPeriodResets, {});
    expect(result.processed).toBe(0);
  });
});

describe("updatePolarCustomerId", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("updates polarCustomerId on user record", async () => {
    const userId = await createFreeUser(t);

    await t.mutation(internal.billing.updatePolarCustomerId, {
      userId,
      polarCustomerId: "polar_cust_new_id",
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.polarCustomerId).toBe("polar_cust_new_id");
  });
});

describe("setCancelAtPeriodEnd", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  test("sets cancelAtPeriodEnd to true", async () => {
    const userId = await createProUser(t);

    await t.mutation(internal.billing.setCancelAtPeriodEnd, {
      userId,
      cancelAtPeriodEnd: true,
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.cancelAtPeriodEnd).toBe(true);
  });

  test("sets cancelAtPeriodEnd to false", async () => {
    const userId = await createProUser(t, { cancelAtPeriodEnd: true });

    await t.mutation(internal.billing.setCancelAtPeriodEnd, {
      userId,
      cancelAtPeriodEnd: false,
    });

    const user = await t.run(async (ctx) => ctx.db.get(userId));
    expect(user!.cancelAtPeriodEnd).toBe(false);
  });
});
