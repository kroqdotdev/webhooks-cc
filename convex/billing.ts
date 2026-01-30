import { v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

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
    //   successUrl: `https://webhooks.cc/billing/success`,
    //   customerEmail: identity.email,
    //   metadata: { odId: identity.subject },
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
    data: v.any(),
  },
  handler: async (ctx, { event, data }) => {
    switch (event) {
      case "subscription.created":
      case "subscription.updated": {
        const userId = data.metadata?.userId;
        if (!userId) return;

        const user = await ctx.db.get(userId);
        if (!user) return;

        await ctx.db.patch(userId, {
          polarCustomerId: data.customerId,
          polarSubscriptionId: data.id,
          subscriptionStatus: "active",
          plan: "pro",
          requestLimit: 500000,
          periodStart: new Date(data.currentPeriodStart).getTime(),
          periodEnd: new Date(data.currentPeriodEnd).getTime(),
          cancelAtPeriodEnd: false,
        });
        break;
      }

      case "subscription.canceled": {
        const user = await ctx.db
          .query("users")
          .withIndex("by_polar_customer", (q) =>
            q.eq("polarCustomerId", data.customerId)
          )
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
          .withIndex("by_polar_customer", (q) =>
            q.eq("polarCustomerId", data.customerId)
          )
          .first();

        if (user) {
          await ctx.db.patch(user._id, {
            plan: "free",
            subscriptionStatus: "canceled",
            requestLimit: 500,
            cancelAtPeriodEnd: false,
          });
        }
        break;
      }
    }
  },
});

// Check and reset billing periods (run daily via cron)
export const checkPeriodResets = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Find users whose period has ended
    const users = await ctx.db
      .query("users")
      .filter((q) =>
        q.and(
          q.neq(q.field("periodEnd"), undefined),
          q.lt(q.field("periodEnd"), now)
        )
      )
      .take(100);

    for (const user of users) {
      if (user.cancelAtPeriodEnd) {
        // Downgrade to free
        await ctx.db.patch(user._id, {
          plan: "free",
          subscriptionStatus: "canceled",
          requestLimit: 500,
          requestsUsed: 0,
          cancelAtPeriodEnd: false,
          periodStart: undefined,
          periodEnd: undefined,
        });
      } else if (user.plan === "pro") {
        // Reset usage for new period
        const newPeriodStart = user.periodEnd!;
        const newPeriodEnd = newPeriodStart + 30 * 24 * 60 * 60 * 1000; // +30 days

        await ctx.db.patch(user._id, {
          requestsUsed: 0,
          periodStart: newPeriodStart,
          periodEnd: newPeriodEnd,
        });
      }
    }

    return { processed: users.length };
  },
});
