/**
 * @fileoverview Billing and subscription management via Polar.sh.
 *
 * Flow:
 * 1. On signup: createOrUpdateUser creates Polar customer, user starts on free tier
 * 2. On upgrade: createCheckout creates Polar checkout URL, user completes payment
 * 3. On payment: subscription.created webhook upgrades user to Pro
 * 4. On cancel: subscription.canceled webhook sets cancelAtPeriodEnd
 * 5. On period end: checkPeriodResets cron downgrades to free
 *
 * Period reset logic:
 * - Pro users: Period aligns with Polar subscription (typically monthly)
 * - Free users: Rolling 24-hour period, lazy activation on first request
 */
import { v } from "convex/values";
import { action, internalAction, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { FREE_REQUEST_LIMIT, PRO_REQUEST_LIMIT, BILLING_PERIOD_MS } from "./config";

/**
 * Create Polar.sh checkout session for upgrading to Pro.
 * Returns the checkout URL to redirect the user to.
 */
export const createCheckout = action({
  args: {},
  handler: async (ctx): Promise<string> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.runQuery(api.users.current);
    if (!user) throw new Error("User not found");

    if (user.plan === "pro") {
      throw new Error("Already on Pro plan");
    }

    // Lazy import Polar SDK to avoid bundling issues
    const { Polar } = await import("@polar-sh/sdk");

    const polar = new Polar({
      accessToken: process.env.POLAR_ACCESS_TOKEN!,
      server: process.env.POLAR_SANDBOX === "true" ? "sandbox" : "production",
    });

    // Create or get customer
    let customerId = user.polarCustomerId;
    if (!customerId) {
      // Create customer in Polar if not exists
      const customer = await polar.customers.create({
        email: user.email,
        name: user.name ?? undefined,
        metadata: {
          userId: user._id,
        },
      });
      customerId = customer.id;

      // Store the customer ID
      await ctx.runMutation(internal.billing.updatePolarCustomerId, {
        userId: user._id,
        polarCustomerId: customer.id,
      });
    }

    const checkout = await polar.checkouts.create({
      products: [process.env.POLAR_PRO_PRODUCT_ID!],
      successUrl: `${process.env.APP_URL}/account?upgraded=true`,
      customerId,
    });

    return checkout.url;
  },
});

/**
 * Internal mutation to update Polar customer ID on user record.
 */
export const updatePolarCustomerId = internalMutation({
  args: {
    userId: v.id("users"),
    polarCustomerId: v.string(),
  },
  handler: async (ctx, { userId, polarCustomerId }) => {
    await ctx.db.patch(userId, { polarCustomerId });
  },
});

/**
 * Cancel subscription at period end.
 * User retains Pro access until their current billing period ends.
 */
export const cancelSubscription = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.runQuery(api.users.current);
    if (!user) throw new Error("User not found");
    if (!user.polarSubscriptionId) {
      throw new Error("No active subscription");
    }

    const { Polar } = await import("@polar-sh/sdk");

    const polar = new Polar({
      accessToken: process.env.POLAR_ACCESS_TOKEN!,
      server: process.env.POLAR_SANDBOX === "true" ? "sandbox" : "production",
    });

    await polar.subscriptions.update({
      id: user.polarSubscriptionId,
      subscriptionUpdate: {
        cancelAtPeriodEnd: true,
      },
    });

    // Update local state immediately
    // Polar will also send subscription.canceled webhook
    await ctx.runMutation(internal.billing.setCancelAtPeriodEnd, {
      userId: user._id,
      cancelAtPeriodEnd: true,
    });
  },
});

/**
 * Resubscribe - undo cancellation before period ends.
 */
export const resubscribe = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.runQuery(api.users.current);
    if (!user) throw new Error("User not found");
    if (!user.polarSubscriptionId) {
      throw new Error("No subscription to reactivate");
    }
    if (!user.cancelAtPeriodEnd) {
      throw new Error("Subscription is not scheduled for cancellation");
    }

    const { Polar } = await import("@polar-sh/sdk");

    const polar = new Polar({
      accessToken: process.env.POLAR_ACCESS_TOKEN!,
      server: process.env.POLAR_SANDBOX === "true" ? "sandbox" : "production",
    });

    await polar.subscriptions.update({
      id: user.polarSubscriptionId,
      subscriptionUpdate: {
        cancelAtPeriodEnd: false,
      },
    });

    // Update local state immediately
    // Polar will also send subscription.uncanceled webhook
    await ctx.runMutation(internal.billing.setCancelAtPeriodEnd, {
      userId: user._id,
      cancelAtPeriodEnd: false,
    });
  },
});

/**
 * Internal mutation to set cancelAtPeriodEnd flag.
 */
export const setCancelAtPeriodEnd = internalMutation({
  args: {
    userId: v.id("users"),
    cancelAtPeriodEnd: v.boolean(),
  },
  handler: async (ctx, { userId, cancelAtPeriodEnd }) => {
    await ctx.db.patch(userId, { cancelAtPeriodEnd });
  },
});

/**
 * Handle Polar webhook events.
 * SECURITY: This mutation is internal-only. The HTTP endpoint verifies
 * the webhook signature before calling this mutation.
 */
export const handleWebhook = internalMutation({
  args: {
    event: v.string(),
    data: v.any(),
  },
  handler: async (ctx, { event, data }) => {
    console.log(`[billing.handleWebhook] Processing event: ${event}`);

    switch (event) {
      // Customer events
      case "customer.created": {
        // Customer was created - verify and log
        console.log(`[billing] Customer created: ${data.id}`);
        break;
      }

      case "customer.updated": {
        // Customer details changed - sync if needed
        console.log(`[billing] Customer updated: ${data.id}`);
        break;
      }

      // Order events
      case "order.paid": {
        // Payment confirmed - subscription.created handles upgrade
        console.log(`[billing] Order paid for customer: ${data.customer_id}`);
        break;
      }

      case "order.refunded": {
        // Refund issued - subscription.revoked will handle downgrade
        console.log(`[billing] Order refunded: ${data.id}`);
        break;
      }

      // Subscription events
      case "subscription.created":
      case "subscription.updated": {
        // User subscribed to Pro or subscription updated
        const userId = data.customer?.metadata?.userId;
        if (!userId) {
          // This can happen for subscriptions created directly in Polar dashboard
          // or legacy customers without metadata
          console.log(
            `[billing] Ignoring ${event} - no userId in metadata (customer: ${data.customer_id}, subscription: ${data.id})`
          );
          return;
        }

        let user;
        try {
          user = await ctx.db.get(userId as Id<"users">);
        } catch {
          console.log(
            `[billing] Ignoring ${event} - invalid userId format: ${userId} (customer: ${data.customer_id})`
          );
          return;
        }
        if (!user) {
          // User was deleted or this is orphaned sandbox data
          console.log(
            `[billing] Ignoring ${event} - user not found: ${userId} (customer: ${data.customer_id})`
          );
          return;
        }

        await ctx.db.patch(user._id, {
          polarCustomerId: data.customer_id,
          polarSubscriptionId: data.id,
          subscriptionStatus: "active",
          plan: "pro",
          requestLimit: PRO_REQUEST_LIMIT,
          periodStart: new Date(data.current_period_start).getTime(),
          periodEnd: new Date(data.current_period_end).getTime(),
          cancelAtPeriodEnd: data.cancel_at_period_end ?? false,
        });
        console.log(`[billing] User ${userId} upgraded to Pro`);
        break;
      }

      case "subscription.canceled": {
        // User canceled - will downgrade at period end
        const user = await ctx.db
          .query("users")
          .withIndex("by_polar_customer", (q) => q.eq("polarCustomerId", data.customer_id))
          .first();

        if (user) {
          await ctx.db.patch(user._id, {
            cancelAtPeriodEnd: true,
            subscriptionStatus: "canceled",
          });
          console.log(`[billing] User ${user._id} subscription canceled`);
        }
        break;
      }

      case "subscription.uncanceled": {
        // User reactivated before period end
        const user = await ctx.db
          .query("users")
          .withIndex("by_polar_customer", (q) => q.eq("polarCustomerId", data.customer_id))
          .first();

        if (user) {
          await ctx.db.patch(user._id, {
            cancelAtPeriodEnd: false,
            subscriptionStatus: "active",
          });
          console.log(`[billing] User ${user._id} subscription reactivated`);
        }
        break;
      }

      case "subscription.revoked": {
        // Immediate cancellation (refund, chargeback, fraud)
        const user = await ctx.db
          .query("users")
          .withIndex("by_polar_customer", (q) => q.eq("polarCustomerId", data.customer_id))
          .first();

        if (user) {
          await ctx.db.patch(user._id, {
            plan: "free",
            subscriptionStatus: undefined,
            requestLimit: FREE_REQUEST_LIMIT,
            requestsUsed: 0,
            cancelAtPeriodEnd: false,
            periodStart: undefined,
            periodEnd: undefined,
            polarSubscriptionId: undefined,
          });
          console.log(`[billing] User ${user._id} subscription revoked - downgraded to free`);
        }
        break;
      }

      case "subscription.active": {
        // Subscription is now active (payment succeeded after past_due)
        const user = await ctx.db
          .query("users")
          .withIndex("by_polar_customer", (q) => q.eq("polarCustomerId", data.customer_id))
          .first();

        if (user) {
          await ctx.db.patch(user._id, {
            subscriptionStatus: "active",
          });
          console.log(`[billing] User ${user._id} subscription now active`);
        }
        break;
      }

      default: {
        console.log(`[billing] Unhandled event: ${event}`);
      }
    }
  },
});

/**
 * Resets billing periods and processes subscription downgrades.
 *
 * For pro users whose period ended:
 * - If cancelAtPeriodEnd is true, downgrades to free tier
 * - Otherwise, starts a new billing period and resets usage
 *
 * Free users are handled via lazy activation:
 * - When a free user's period expires, resetFreeUserPeriod clears periodEnd
 * - On next request, checkAndStartPeriod starts a new 24-hour period
 *
 * Processes up to 100 users per run to avoid timeout.
 */
export const checkPeriodResets = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let processed = 0;

    // Find users whose period has ended using the index for efficient range query
    const expiredUsers = await ctx.db
      .query("users")
      .withIndex("by_period_end", (q) => q.lt("periodEnd", now))
      .take(100);

    for (const user of expiredUsers) {
      // Skip free users - they use lazy activation via scheduled mutations
      if (user.plan === "free") {
        continue;
      }

      if (user.cancelAtPeriodEnd) {
        // Downgrade to free - clear period so it starts fresh on next request
        await ctx.db.patch(user._id, {
          plan: "free",
          subscriptionStatus: undefined,
          requestLimit: FREE_REQUEST_LIMIT,
          requestsUsed: 0,
          cancelAtPeriodEnd: false,
          periodStart: undefined,
          periodEnd: undefined,
          polarSubscriptionId: undefined,
        });
        console.log(`[billing] User ${user._id} downgraded to free after period end`);
        processed++;
      } else if (user.plan === "pro" && user.periodEnd) {
        // Reset usage for new period
        const newPeriodStart = user.periodEnd;
        const newPeriodEnd = newPeriodStart + BILLING_PERIOD_MS;

        await ctx.db.patch(user._id, {
          requestsUsed: 0,
          periodStart: newPeriodStart,
          periodEnd: newPeriodEnd,
        });
        console.log(`[billing] User ${user._id} period reset`);
        processed++;
      }
    }

    return { processed };
  },
});

/**
 * Create a Polar customer for a new user.
 * Called from auth.ts createOrUpdateUser callback via scheduler.
 * This is an internal action that calls the Polar API directly.
 */
export const createPolarCustomer = internalAction({
  args: {
    userId: v.id("users"),
    email: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, { userId, email, name }) => {
    try {
      const { Polar } = await import("@polar-sh/sdk");

      const polar = new Polar({
        accessToken: process.env.POLAR_ACCESS_TOKEN!,
        server: process.env.POLAR_SANDBOX === "true" ? "sandbox" : "production",
      });

      const customer = await polar.customers.create({
        email,
        name: name ?? undefined,
        metadata: {
          userId,
        },
      });

      await ctx.runMutation(internal.billing.updatePolarCustomerId, {
        userId,
        polarCustomerId: customer.id,
      });

      console.log(`[billing] Created Polar customer ${customer.id} for user ${userId}`);
    } catch (error) {
      console.error(`[billing] Failed to create Polar customer for user ${userId}:`, error);
      // Don't throw - user can still use the app, customer will be created on checkout
    }
  },
});
