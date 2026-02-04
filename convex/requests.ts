import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { EPHEMERAL_RATE_LIMIT } from "./rateLimiter";
import { FREE_PERIOD_MS, PRO_REQUEST_RETENTION_MS } from "./config";

// Internal mutation - only called from the HTTP action in http.ts
export const capture = internalMutation({
  args: {
    slug: v.string(),
    method: v.string(),
    path: v.string(),
    headers: v.record(v.string(), v.string()),
    body: v.optional(v.string()),
    queryParams: v.record(v.string(), v.string()),
    ip: v.string(),
  },
  handler: async (ctx, args) => {
    // Find endpoint
    const endpoint = await ctx.db
      .query("endpoints")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (!endpoint) {
      return { error: "not_found" };
    }

    // Check if expired
    if (endpoint.expiresAt && endpoint.expiresAt < Date.now()) {
      return { error: "expired" };
    }

    // Note: Rate limits for both ephemeral and authenticated endpoints are enforced
    // by the Go receiver via the quota cache. This avoids reading user/rate limit
    // state here, preventing OCC conflicts when many concurrent webhooks hit.
    // This avoids reading the user document here, preventing OCC conflicts when
    // many concurrent webhooks hit the same user's endpoints.

    const contentType = args.headers["content-type"] || args.headers["Content-Type"];
    const size = args.body ? new TextEncoder().encode(args.body).length : 0;

    // Store request
    await ctx.db.insert("requests", {
      endpointId: endpoint._id,
      method: args.method,
      path: args.path,
      headers: args.headers,
      body: args.body,
      queryParams: args.queryParams,
      contentType,
      ip: args.ip,
      size,
      receivedAt: Date.now(),
    });

    // Schedule usage increment to run immediately after this mutation commits.
    // Scheduled mutations run sequentially, avoiding OCC conflicts when many
    // concurrent requests hit the same user's endpoints.
    if (endpoint.userId) {
      await ctx.scheduler.runAfter(0, internal.requests.incrementUsage, {
        userId: endpoint.userId,
      });
    }

    return {
      success: true,
      mockResponse: endpoint.mockResponse ?? {
        status: 200,
        body: "OK",
        headers: {},
      },
    };
  },
});

// Get quota information for a slug - used by Go receiver for rate limiting.
// Returns remaining quota, limit, period end, and plan for caching in the receiver.
// For free users, also indicates if period needs to be started.
export const getQuota = internalQuery({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, { slug }) => {
    const endpoint = await ctx.db
      .query("endpoints")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!endpoint) {
      return { error: "not_found" as const };
    }

    // Ephemeral endpoints get 50 requests for their lifetime
    // Count actual requests to track usage across Go receiver cache refreshes
    // Cap read to EPHEMERAL_RATE_LIMIT + 1 to avoid loading excess data
    if (endpoint.isEphemeral) {
      const requests = await ctx.db
        .query("requests")
        .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
        .take(EPHEMERAL_RATE_LIMIT + 1);
      const used = requests.length;
      const remaining = Math.max(0, EPHEMERAL_RATE_LIMIT - used);
      return {
        userId: null,
        remaining,
        limit: EPHEMERAL_RATE_LIMIT,
        periodEnd: endpoint.expiresAt ?? null,
        plan: "ephemeral",
        needsPeriodStart: false,
      };
    }

    // Endpoints without a user (shouldn't happen, but handle gracefully)
    if (!endpoint.userId) {
      return {
        userId: null,
        remaining: EPHEMERAL_RATE_LIMIT,
        limit: EPHEMERAL_RATE_LIMIT,
        periodEnd: null,
        plan: null,
        needsPeriodStart: false,
      };
    }

    const user = await ctx.db.get(endpoint.userId);
    if (!user) {
      // User was deleted but endpoint still exists - treat as unlimited
      return {
        userId: null,
        remaining: -1,
        limit: -1,
        periodEnd: null,
        plan: null,
        needsPeriodStart: false,
      };
    }

    const now = Date.now();
    const periodExpired = !user.periodEnd || user.periodEnd < now;

    // For free users, check if period needs to start/restart
    if (user.plan === "free" && periodExpired) {
      return {
        userId: endpoint.userId,
        remaining: user.requestLimit, // Full quota after period restart
        limit: user.requestLimit,
        periodEnd: null,
        plan: user.plan,
        needsPeriodStart: true,
      };
    }

    return {
      userId: endpoint.userId,
      remaining: Math.max(0, user.requestLimit - user.requestsUsed),
      limit: user.requestLimit,
      periodEnd: user.periodEnd ?? null,
      plan: user.plan,
      needsPeriodStart: false,
    };
  },
});

// Check and start a new period for a free user if needed.
// Called by Go receiver before capturing requests when needsPeriodStart is true.
// Returns the new quota information after potentially starting a new period.
// This mutation is idempotent - concurrent calls will detect if period was already started.
export const checkAndStartPeriod = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) {
      return { error: "not_found" as const };
    }

    // Only process free users
    if (user.plan !== "free") {
      return {
        remaining: Math.max(0, user.requestLimit - user.requestsUsed),
        limit: user.requestLimit,
        periodEnd: user.periodEnd ?? null,
      };
    }

    const now = Date.now();

    // Check if period is still valid (another concurrent request may have started it)
    if (user.periodEnd && user.periodEnd > now) {
      // Period already active - check quota and return current state
      if (user.requestsUsed >= user.requestLimit) {
        return {
          error: "quota_exceeded" as const,
          retryAfter: user.periodEnd - now,
          periodEnd: user.periodEnd,
        };
      }
      return {
        remaining: Math.max(0, user.requestLimit - user.requestsUsed),
        limit: user.requestLimit,
        periodEnd: user.periodEnd,
      };
    }

    // Period expired or never started - start new 24-hour period
    const newPeriodEnd = now + FREE_PERIOD_MS;
    await ctx.db.patch(userId, {
      periodStart: now,
      periodEnd: newPeriodEnd,
      requestsUsed: 0,
    });

    // Schedule reset mutation for when period expires
    await ctx.scheduler.runAt(newPeriodEnd, internal.users.resetFreeUserPeriod, {
      userId,
    });

    return {
      remaining: user.requestLimit,
      limit: user.requestLimit,
      periodEnd: newPeriodEnd,
    };
  },
});

// Increment user's request usage counter.
// Called via scheduler from capture to avoid OCC conflicts.
// Supports batch increments via the count parameter (capped at 1000 per call).
export const incrementUsage = internalMutation({
  args: {
    userId: v.id("users"),
    count: v.optional(v.number()),
  },
  handler: async (ctx, { userId, count = 1 }) => {
    // Validate count is a reasonable positive integer (cap at 1000 per batch)
    const validCount = Math.max(1, Math.min(Math.floor(count), 1000));

    const user = await ctx.db.get(userId);
    if (user) {
      await ctx.db.patch(userId, {
        requestsUsed: user.requestsUsed + validCount,
      });
    }
  },
});

// Get endpoint info for caching in Go receiver.
// Returns endpoint details including mock response configuration.
export const getEndpointInfo = internalQuery({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, { slug }) => {
    const endpoint = await ctx.db
      .query("endpoints")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!endpoint) {
      return { error: "not_found" as const };
    }

    return {
      endpointId: endpoint._id,
      userId: endpoint.userId ?? null,
      isEphemeral: endpoint.isEphemeral ?? false,
      expiresAt: endpoint.expiresAt ?? null,
      mockResponse: endpoint.mockResponse ?? {
        status: 200,
        body: "OK",
        headers: {},
      },
    };
  },
});

// Batch capture mutation for high-throughput webhook ingestion.
// Accepts an array of requests for a single slug and inserts them all at once.
// This reduces OCC conflicts by batching multiple requests into one mutation.
export const captureBatch = internalMutation({
  args: {
    slug: v.string(),
    requests: v.array(
      v.object({
        method: v.string(),
        path: v.string(),
        headers: v.record(v.string(), v.string()),
        body: v.optional(v.string()),
        queryParams: v.record(v.string(), v.string()),
        ip: v.string(),
        receivedAt: v.number(),
      })
    ),
  },
  handler: async (ctx, { slug, requests }) => {
    // Find endpoint
    const endpoint = await ctx.db
      .query("endpoints")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!endpoint) {
      return { error: "not_found", inserted: 0 };
    }

    // Check if expired
    if (endpoint.expiresAt && endpoint.expiresAt < Date.now()) {
      return { error: "expired", inserted: 0 };
    }

    // Note: Rate limits enforced by Go receiver via quota cache

    // Insert all requests
    let inserted = 0;
    for (const req of requests) {
      const contentType = req.headers["content-type"] || req.headers["Content-Type"];
      const size = req.body ? new TextEncoder().encode(req.body).length : 0;

      await ctx.db.insert("requests", {
        endpointId: endpoint._id,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body,
        queryParams: req.queryParams,
        contentType,
        ip: req.ip,
        size,
        receivedAt: req.receivedAt,
      });
      inserted++;
    }

    // Schedule single usage increment for the entire batch
    if (endpoint.userId && inserted > 0) {
      await ctx.scheduler.runAfter(0, internal.requests.incrementUsage, {
        userId: endpoint.userId,
        count: inserted,
      });
    }

    return { success: true, inserted };
  },
});

// --- Internal functions for CLI API routes ---

export const getForUser = internalQuery({
  args: { requestId: v.id("requests"), userId: v.id("users") },
  handler: async (ctx, { requestId, userId }) => {
    const request = await ctx.db.get(requestId);
    if (!request) return null;

    const endpoint = await ctx.db.get(request.endpointId);
    if (!endpoint) return null;
    if (endpoint.userId !== userId) return null;

    return request;
  },
});

export const listNewForUser = internalQuery({
  args: {
    endpointId: v.id("endpoints"),
    userId: v.id("users"),
    afterTimestamp: v.number(),
  },
  handler: async (ctx, { endpointId, userId, afterTimestamp }) => {
    const endpoint = await ctx.db.get(endpointId);
    if (!endpoint) return [];
    if (endpoint.userId !== userId) return [];

    return await ctx.db
      .query("requests")
      .withIndex("by_endpoint_time", (q) =>
        q.eq("endpointId", endpointId).gt("receivedAt", afterTimestamp)
      )
      .order("asc")
      .take(100);
  },
});

// Maximum number of requests that can be fetched at once
const MAX_LIST_LIMIT = 100;

// Maximum count to avoid loading too much data into memory
const MAX_COUNT = 1000;

export const count = query({
  args: {
    endpointId: v.id("endpoints"),
  },
  handler: async (ctx, { endpointId }) => {
    const userId = await getAuthUserId(ctx);

    // Verify the user has access to this endpoint
    const endpoint = await ctx.db.get(endpointId);
    if (!endpoint) return 0;

    // Authorization rules (same as list)
    if (!endpoint.isEphemeral) {
      if (!endpoint.userId || !userId || endpoint.userId !== userId) {
        return 0;
      }
    }

    // Use take() with a cap to avoid loading unlimited data into memory
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpointId))
      .take(MAX_COUNT + 1);

    // Return actual count, or MAX_COUNT if there are more
    return Math.min(requests.length, MAX_COUNT);
  },
});

export const list = query({
  args: {
    endpointId: v.id("endpoints"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { endpointId, limit = 50 }) => {
    // Validate and cap the limit to prevent excessive data retrieval
    const actualLimit = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
    const userId = await getAuthUserId(ctx);

    // Verify the user has access to this endpoint
    const endpoint = await ctx.db.get(endpointId);
    if (!endpoint) return [];

    // Authorization rules:
    // 1. Ephemeral endpoints can be viewed by anyone (for the live demo)
    // 2. Endpoints with an owner can only be viewed by that owner
    // 3. Unowned non-ephemeral endpoints should not exist, but if they do, deny access
    if (!endpoint.isEphemeral) {
      if (!endpoint.userId || !userId || endpoint.userId !== userId) {
        return [];
      }
    }

    const requests = await ctx.db
      .query("requests")
      .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpointId))
      .order("desc")
      .take(actualLimit);

    return requests;
  },
});

export const get = query({
  args: { id: v.id("requests") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    const request = await ctx.db.get(id);

    if (!request) return null;

    // Verify the user has access to the endpoint this request belongs to
    const endpoint = await ctx.db.get(request.endpointId);
    if (!endpoint) return null;

    // Authorization rules:
    // 1. Ephemeral endpoints can be viewed by anyone
    // 2. Endpoints with an owner can only be viewed by that owner
    // 3. Unowned non-ephemeral endpoints should not exist, but if they do, deny access
    if (!endpoint.isEphemeral) {
      if (!endpoint.userId || !userId || endpoint.userId !== userId) {
        return null;
      }
    }

    return request;
  },
});

// Maximum requests to delete per endpoint in a single run to avoid timeout
const CLEANUP_BATCH_SIZE = 100;

// Cleanup expired ephemeral endpoints and their requests
export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Use index properly with range query for expiresAt
    // Note: endpoints with expiresAt: undefined won't match q.lt("expiresAt", now)
    const expired = await ctx.db
      .query("endpoints")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(100);

    let deletedEndpoints = 0;
    let deletedRequests = 0;

    for (const endpoint of expired) {
      // Safety: only delete ephemeral endpoints
      if (!endpoint.isEphemeral) {
        console.warn(
          `Skipping non-ephemeral endpoint ${endpoint._id} with expiresAt=${endpoint.expiresAt}`
        );
        continue;
      }

      // Delete requests in batches to avoid timeout
      const requests = await ctx.db
        .query("requests")
        .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
        .take(CLEANUP_BATCH_SIZE);

      for (const request of requests) {
        await ctx.db.delete(request._id);
        deletedRequests++;
      }

      // Only delete endpoint if all requests have been cleaned
      // If there are exactly CLEANUP_BATCH_SIZE requests, there might be more
      if (requests.length < CLEANUP_BATCH_SIZE) {
        await ctx.db.delete(endpoint._id);
        deletedEndpoints++;
      }
    }

    return { deletedEndpoints, deletedRequests };
  },
});

// Delete all requests for a user's endpoints.
// Called when free user period resets to clean up old requests.
// Processes in batches and reschedules if more remain.
// Limits endpoints per run to avoid timeout on users with many endpoints.
export const cleanupUserRequests = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    // Limit endpoints per run to avoid timeout
    const endpoints = await ctx.db
      .query("endpoints")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(20);

    let deleted = 0;
    for (const endpoint of endpoints) {
      const requests = await ctx.db
        .query("requests")
        .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
        .take(CLEANUP_BATCH_SIZE);

      for (const req of requests) {
        await ctx.db.delete(req._id);
        deleted++;
      }

      // If we hit the batch limit on any endpoint, reschedule
      if (requests.length === CLEANUP_BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.requests.cleanupUserRequests, {
          userId,
        });
        return { deleted, complete: false };
      }
    }

    return { deleted, complete: true };
  },
});

// Delete requests older than 30 days for pro users.
// Runs daily to enforce retention policy.
// Uses pagination to process all pro users across multiple cron invocations.
export const cleanupOldRequests = internalMutation({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { cursor }) => {
    const cutoff = Date.now() - PRO_REQUEST_RETENTION_MS;

    // Use index for efficient lookup and paginate through users
    const result = await ctx.db
      .query("users")
      .withIndex("by_plan", (q) => q.eq("plan", "pro"))
      .paginate({ cursor: cursor ?? null, numItems: 20 });

    let totalDeleted = 0;
    for (const user of result.page) {
      // Limit endpoints per user to avoid timeout
      const endpoints = await ctx.db
        .query("endpoints")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .take(20);

      for (const endpoint of endpoints) {
        const oldRequests = await ctx.db
          .query("requests")
          .withIndex("by_endpoint_time", (q) =>
            q.eq("endpointId", endpoint._id).lt("receivedAt", cutoff)
          )
          .take(CLEANUP_BATCH_SIZE);

        for (const req of oldRequests) {
          await ctx.db.delete(req._id);
          totalDeleted++;
        }
      }
    }

    // Schedule continuation if there are more users
    if (!result.isDone) {
      await ctx.scheduler.runAfter(100, internal.requests.cleanupOldRequests, {
        cursor: result.continueCursor,
      });
    }

    return { deleted: totalDeleted, done: result.isDone };
  },
});
