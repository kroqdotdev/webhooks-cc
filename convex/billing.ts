/**
 * @fileoverview Billing and subscription management via Polar.sh webhooks.
 *
 * Period reset logic:
 * - Pro users: Period aligns with Polar subscription (typically monthly)
 * - Free users: Rolling 30-day period, reset when exceeded
 * - checkPeriodResets runs daily via cron to process resets
 *
 * Downgrade flow:
 * - User cancels -> cancelAtPeriodEnd set to true
 * - At period end, checkPeriodResets downgrades to free tier
 * - Request limits reset, subscription fields cleared
 */
import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { FREE_REQUEST_LIMIT, PRO_REQUEST_LIMIT, BILLING_PERIOD_MS } from "./config";

// Polar webhook event data validator
const polarSubscriptionData = v.object({
  id: v.string(),
  customerId: v.string(),
  currentPeriodStart: v.string(),
  currentPeriodEnd: v.string(),
  metadata: v.optional(
    v.object({
      userId: v.optional(v.string()),
    })
  ),
});

// Create Polar.sh checkout session
export const createCheckout = action({
  args: {},
  handler: async (ctx): Promise<string> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // This would use the Polar SDK
    // const polar = new Polar({ accessToken: process.env.POLAR_ACCESS_TOKEN });
    // const checkout = await polar.checkouts.create({
    //   productPriceId: process.env.POLAR_PRO_PRICE_ID,
    //   successUrl: `${process.env.APP_URL}/billing/success`,
    //   customerEmail: identity.email,
    //   metadata: { userId: identity.subject },
    // });
    // return checkout.url;

    // Placeholder until Polar is configured
    return "https://polar.sh/checkout/placeholder";
  },
});

// Handle Polar webhook events
// SECURITY: This mutation is internal-only. The HTTP endpoint that calls this
// must verify the Polar webhook signature using the POLAR_WEBHOOK_SECRET before
// invoking this mutation. See: https://docs.polar.sh/developers/webhooks/signature
export const handleWebhook = internalMutation({
  args: {
    event: v.string(),
    data: polarSubscriptionData,
  },
  handler: async (ctx, { event, data }) => {
    switch (event) {
      case "subscription.created":
      case "subscription.updated": {
        const userIdStr = data.metadata?.userId;
        if (!userIdStr) return;

        // Validate the user exists before using the ID
        // ctx.db.get will return null if the ID format is invalid or user doesn't exist
        let user;
        try {
          user = await ctx.db.get(userIdStr as Id<"users">);
        } catch {
          console.error(`Invalid userId format in webhook metadata: ${userIdStr}`);
          return;
        }
        if (!user) {
          console.error(`User not found for webhook: ${userIdStr}`);
          return;
        }
        const userId = user._id;

        await ctx.db.patch(userId, {
          polarCustomerId: data.customerId,
          polarSubscriptionId: data.id,
          subscriptionStatus: "active",
          plan: "pro",
          requestLimit: PRO_REQUEST_LIMIT,
          periodStart: new Date(data.currentPeriodStart).getTime(),
          periodEnd: new Date(data.currentPeriodEnd).getTime(),
          cancelAtPeriodEnd: false,
        });
        break;
      }

      case "subscription.canceled": {
        const user = await ctx.db
          .query("users")
          .withIndex("by_polar_customer", (q) => q.eq("polarCustomerId", data.customerId))
          .first();

        if (user) {
          await ctx.db.patch(user._id, {
            cancelAtPeriodEnd: true,
          });
        }
        break;
      }

      case "subscription.revoked": {
        const user = await ctx.db
          .query("users")
          .withIndex("by_polar_customer", (q) => q.eq("polarCustomerId", data.customerId))
          .first();

        if (user) {
          await ctx.db.patch(user._id, {
            plan: "free",
            subscriptionStatus: "canceled",
            requestLimit: FREE_REQUEST_LIMIT,
            cancelAtPeriodEnd: false,
          });
        }
        break;
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
 * For free users whose period ended:
 * - Resets requestsUsed to 0 and starts a new 30-day period
 *
 * Processes up to 100 users per run to avoid timeout.
 */
export const checkPeriodResets = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let processed = 0;

    // Find pro users whose period has ended
    const proUsers = await ctx.db
      .query("users")
      .filter((q) => q.and(q.neq(q.field("periodEnd"), undefined), q.lt(q.field("periodEnd"), now)))
      .take(100);

    for (const user of proUsers) {
      if (user.cancelAtPeriodEnd) {
        // Downgrade to free
        await ctx.db.patch(user._id, {
          plan: "free",
          subscriptionStatus: "canceled",
          requestLimit: FREE_REQUEST_LIMIT,
          requestsUsed: 0,
          cancelAtPeriodEnd: false,
          periodStart: undefined,
          periodEnd: undefined,
        });
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
        processed++;
      }
    }

    // Reset free users who have exceeded their limit
    // Free users get a rolling 30-day period, reset when their period ends
    const freeUsers = await ctx.db
      .query("users")
      .filter((q) =>
        q.and(
          q.eq(q.field("plan"), "free"),
          q.or(
            // Never had a period set (legacy users)
            q.eq(q.field("periodStart"), undefined),
            // Period has ended
            q.and(q.neq(q.field("periodEnd"), undefined), q.lt(q.field("periodEnd"), now))
          )
        )
      )
      .take(100);

    for (const user of freeUsers) {
      // Reset usage and set a new 30-day period
      await ctx.db.patch(user._id, {
        requestsUsed: 0,
        periodStart: now,
        periodEnd: now + BILLING_PERIOD_MS,
      });
      processed++;
    }

    return { processed };
  },
});
