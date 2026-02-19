import { getAuthUserId } from "@convex-dev/auth/server";
import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const current = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const user = await ctx.db.get(userId);
    if (!user) return null;

    // Filter out internal billing IDs that shouldn't be exposed to clients
    const { polarCustomerId: _, polarSubscriptionId: __, ...publicUser } = user;
    return publicUser;
  },
});

/** Internal query returning full user data (including Polar IDs) for server-side billing actions. */
export const currentFull = internalQuery({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.db.get(userId);
  },
});

/**
 * Returns the list of auth providers linked to the current user.
 * Used to display Github/Google badges on the account page.
 */
export const getAuthProviders = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    // Use the userIdAndProvider index for efficient lookup
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .collect();

    return accounts.map((account) => account.provider);
  },
});

// Delete at most 50 items per batch to avoid Convex timeout
const DELETE_BATCH_SIZE = 50;

/**
 * Initiates account deletion by scheduling the deletion process.
 * This prevents timeout issues for users with large amounts of data.
 */
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Schedule the deletion process to run immediately
    await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
      userId,
      phase: "requests",
    });

    return { success: true, message: "Account deletion initiated" };
  },
});

/**
 * Internal mutation that progressively deletes user data in phases.
 * Re-schedules itself if more work remains to avoid timeout.
 *
 * Phases: requests -> endpoints -> apiKeys -> sessions -> authAccounts -> user
 */
export const processAccountDeletion = internalMutation({
  args: {
    userId: v.id("users"),
    phase: v.union(
      v.literal("requests"),
      v.literal("endpoints"),
      v.literal("apiKeys"),
      v.literal("sessions"),
      v.literal("authAccounts"),
      v.literal("user")
    ),
  },
  handler: async (ctx, { userId, phase }) => {
    // Verify user still exists (may have been deleted by a previous run)
    const user = await ctx.db.get(userId);
    if (!user) return;

    if (phase === "requests") {
      // Find an endpoint with requests to delete
      const endpoints = await ctx.db
        .query("endpoints")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(1);

      if (endpoints.length > 0) {
        const endpoint = endpoints[0];
        const requests = await ctx.db
          .query("requests")
          .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
          .take(DELETE_BATCH_SIZE);

        for (const request of requests) {
          await ctx.db.delete(request._id);
        }

        // If we deleted a full batch, there may be more requests
        if (requests.length === DELETE_BATCH_SIZE) {
          await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
            userId,
            phase: "requests",
          });
          return;
        }

        // No more requests for this endpoint, delete the endpoint
        await ctx.db.delete(endpoint._id);

        // Check if there are more endpoints
        await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
          userId,
          phase: "requests",
        });
        return;
      }

      // No more endpoints with requests, move to next phase
      await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
        userId,
        phase: "endpoints",
      });
      return;
    }

    if (phase === "endpoints") {
      // Delete any remaining endpoints (shouldn't be any, but just in case)
      const endpoints = await ctx.db
        .query("endpoints")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(DELETE_BATCH_SIZE);

      for (const endpoint of endpoints) {
        await ctx.db.delete(endpoint._id);
      }

      if (endpoints.length === DELETE_BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
          userId,
          phase: "endpoints",
        });
        return;
      }

      await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
        userId,
        phase: "apiKeys",
      });
      return;
    }

    if (phase === "apiKeys") {
      const apiKeys = await ctx.db
        .query("apiKeys")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(DELETE_BATCH_SIZE);

      for (const apiKey of apiKeys) {
        await ctx.db.delete(apiKey._id);
      }

      if (apiKeys.length === DELETE_BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
          userId,
          phase: "apiKeys",
        });
        return;
      }

      await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
        userId,
        phase: "sessions",
      });
      return;
    }

    if (phase === "sessions") {
      const sessions = await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", userId))
        .take(DELETE_BATCH_SIZE);

      for (const session of sessions) {
        // Delete refresh tokens for this session
        const refreshTokens = await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
          .collect();

        for (const token of refreshTokens) {
          await ctx.db.delete(token._id);
        }

        await ctx.db.delete(session._id);
      }

      if (sessions.length === DELETE_BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
          userId,
          phase: "sessions",
        });
        return;
      }

      await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
        userId,
        phase: "authAccounts",
      });
      return;
    }

    if (phase === "authAccounts") {
      const authAccounts = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
        .take(DELETE_BATCH_SIZE);

      for (const account of authAccounts) {
        // Delete any pending verification codes for this account
        const verificationCodes = await ctx.db
          .query("authVerificationCodes")
          .withIndex("accountId", (q) => q.eq("accountId", account._id))
          .collect();

        for (const code of verificationCodes) {
          await ctx.db.delete(code._id);
        }

        await ctx.db.delete(account._id);
      }

      if (authAccounts.length === DELETE_BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
          userId,
          phase: "authAccounts",
        });
        return;
      }

      await ctx.scheduler.runAfter(0, internal.users.processAccountDeletion, {
        userId,
        phase: "user",
      });
      return;
    }

    if (phase === "user") {
      // Final phase: delete the user document
      await ctx.db.delete(userId);
    }
  },
});

/**
 * Resets a free user's period end marker.
 * Called via scheduler when a free user's 24-hour period expires.
 * Clears periodEnd and requestsUsed to mark as "ready for new period" -
 * next request will trigger a new period (lazy activation).
 */
export const resetFreeUserPeriod = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user || user.plan !== "free") return;

    // Clear periodEnd and reset usage to mark as "ready for new period"
    // Next request will trigger new period (lazy activation)
    await ctx.db.patch(userId, {
      periodEnd: undefined,
      requestsUsed: 0,
    });
  },
});

/**
 * Internal query to fetch a user's current plan by id.
 * Used by internal HTTP actions (shared-secret authenticated).
 */
export const getPlanById = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    return user?.plan ?? null;
  },
});

/**
 * Internal query to page users by plan.
 * Used by receiver retention workers to enforce plan-specific retention in ClickHouse.
 */
export const listByPlanPaginated = internalQuery({
  args: {
    plan: v.union(v.literal("free"), v.literal("pro")),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { plan, cursor, limit }) => {
    const pageSize = Math.max(1, Math.min(500, Math.floor(limit ?? 200)));
    const result = await ctx.db
      .query("users")
      .withIndex("by_plan", (q) => q.eq("plan", plan))
      .paginate({ cursor: cursor ?? null, numItems: pageSize });

    return {
      userIds: result.page.map((user) => String(user._id)),
      nextCursor: result.isDone ? null : result.continueCursor,
      done: result.isDone,
    };
  },
});
