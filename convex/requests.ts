import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { EPHEMERAL_RATE_LIMIT } from "./rateLimiter";
import { FREE_PERIOD_MS, FREE_REQUEST_RETENTION_MS, PRO_REQUEST_RETENTION_MS } from "./config";

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
    // by the receiver via the quota cache. This avoids reading user/rate limit
    // state here, preventing OCC conflicts when many concurrent webhooks hit
    // the same user's endpoints.

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

    // Schedule request count increment for the endpoint (all endpoints, including ephemeral)
    await ctx.scheduler.runAfter(0, internal.requests.incrementRequestCount, {
      endpointId: endpoint._id,
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

// Get quota information for a slug - used by receiver for rate limiting.
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

    // Guest ephemeral endpoints (no user) get 50 requests for their lifetime.
    // User-owned ephemeral endpoints (e.g. CLI tunnel) fall through to user quota.
    if (endpoint.isEphemeral && !endpoint.userId) {
      const used = endpoint.requestCount ?? 0;
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
// Called by receiver before capturing requests when needsPeriodStart is true.
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

// Increment the denormalized request count on an endpoint.
// Called via scheduler from capture/captureBatch to avoid OCC conflicts.
// No-ops for count <= 0 or deleted endpoints.
export const incrementRequestCount = internalMutation({
  args: {
    endpointId: v.id("endpoints"),
    count: v.optional(v.number()),
  },
  handler: async (ctx, { endpointId, count = 1 }) => {
    const validCount = Math.min(Math.floor(count), 1000);
    if (validCount <= 0) return;
    const endpoint = await ctx.db.get(endpointId);
    if (endpoint) {
      await ctx.db.patch(endpointId, {
        requestCount: (endpoint.requestCount ?? 0) + validCount,
      });
    }
  },
});

// Decrement the denormalized request count on an endpoint.
// Used by cleanup paths when requests are deleted from live endpoints.
// No-ops for count <= 0 or deleted endpoints.
export const decrementRequestCount = internalMutation({
  args: {
    endpointId: v.id("endpoints"),
    count: v.number(),
  },
  handler: async (ctx, { endpointId, count }) => {
    const validCount = Math.min(Math.floor(count), 1000);
    if (validCount <= 0) return;
    const endpoint = await ctx.db.get(endpointId);
    if (endpoint) {
      await ctx.db.patch(endpointId, {
        requestCount: Math.max(0, (endpoint.requestCount ?? 0) - validCount),
      });
    }
  },
});

// Get endpoint info for caching in receiver.
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

    // Note: Rate limits enforced by receiver via quota cache

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

    // Schedule request count increment for the endpoint
    if (inserted > 0) {
      await ctx.scheduler.runAfter(0, internal.requests.incrementRequestCount, {
        endpointId: endpoint._id,
        count: inserted,
      });
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

export const listForUser = internalQuery({
  args: {
    endpointId: v.id("endpoints"),
    userId: v.id("users"),
    limit: v.optional(v.number()),
    since: v.optional(v.number()),
  },
  handler: async (ctx, { endpointId, userId, limit = 50, since }) => {
    const endpoint = await ctx.db.get(endpointId);
    if (!endpoint) return [];
    if (endpoint.userId !== userId) return [];

    const actualLimit = Math.min(Math.max(1, limit), 1000);
    const actualSince = since !== undefined ? Math.max(0, since) : undefined;

    if (actualSince !== undefined) {
      return await ctx.db
        .query("requests")
        .withIndex("by_endpoint_time", (q) =>
          q.eq("endpointId", endpointId).gt("receivedAt", actualSince)
        )
        .order("desc")
        .take(actualLimit);
    }

    return await ctx.db
      .query("requests")
      .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpointId))
      .order("desc")
      .take(actualLimit);
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
    if (!endpoint) return null;
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

// Public query for real-time SSE subscriptions via ConvexClient.onUpdate.
// Auth is handled by the SSE route (API key validation + endpoint ownership check)
// before subscribing. Returns null when endpoint is deleted.
export const listNewForStream = query({
  args: {
    endpointId: v.id("endpoints"),
    afterTimestamp: v.number(),
    userId: v.string(),
  },
  handler: async (ctx, { endpointId, afterTimestamp, userId }) => {
    const endpoint = await ctx.db.get(endpointId);
    if (!endpoint) return null;

    // Defense-in-depth: verify endpoint belongs to requesting user
    if (endpoint.userId === undefined || String(endpoint.userId) !== userId) {
      return null;
    }

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

export const count = query({
  args: {
    endpointId: v.id("endpoints"),
  },
  handler: async (ctx, { endpointId }) => {
    const userId = await getAuthUserId(ctx);

    const endpoint = await ctx.db.get(endpointId);
    if (!endpoint) return 0;

    if (!endpoint.isEphemeral) {
      if (!endpoint.userId || !userId || endpoint.userId !== userId) {
        return 0;
      }
    }

    return endpoint.requestCount ?? 0;
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

export const listSummaries = query({
  args: {
    endpointId: v.id("endpoints"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { endpointId, limit = 50 }) => {
    const actualLimit = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
    const userId = await getAuthUserId(ctx);

    const endpoint = await ctx.db.get(endpointId);
    if (!endpoint) return [];

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

    return requests.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      method: r.method,
      receivedAt: r.receivedAt,
    }));
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

// Drain remaining requests for a deleted endpoint.
// Called when endpoint deletion found more than DELETE_BATCH_SIZE requests.
// Reschedules itself until all requests are gone.
export const drainOrphanedRequests = internalMutation({
  args: { endpointId: v.id("endpoints") },
  handler: async (ctx, { endpointId }) => {
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpointId))
      .take(CLEANUP_BATCH_SIZE);

    for (const req of requests) {
      await ctx.db.delete(req._id);
    }

    if (requests.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.requests.drainOrphanedRequests, {
        endpointId,
      });
    }

    return { deleted: requests.length };
  },
});

// Cleanup expired ephemeral endpoints and their requests
export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Use index range query: gte(0) excludes undefined (sorts before numbers in Convex)
    const expired = await ctx.db
      .query("endpoints")
      .withIndex("by_expires", (q) => q.gte("expiresAt", 0).lt("expiresAt", now))
      .take(100);

    let deletedEndpoints = 0;
    let deletedRequests = 0;

    for (const endpoint of expired) {
      // Safety: only delete ephemeral endpoints
      if (!endpoint.isEphemeral) {
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

      // Always delete the endpoint immediately so it stops appearing in queries.
      // If more requests remain, schedule async drain to clean them up.
      await ctx.db.delete(endpoint._id);
      deletedEndpoints++;

      if (requests.length === CLEANUP_BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.requests.drainOrphanedRequests, {
          endpointId: endpoint._id,
        });
      }
    }

    return { deletedEndpoints, deletedRequests };
  },
});

// Delete all requests for a user's endpoints.
// Called when free user period resets to clean up old requests.
// Processes in batches and reschedules if more remain.
// Paginates through endpoints to handle users with many endpoints.
export const cleanupUserRequests = internalMutation({
  args: {
    userId: v.id("users"),
    endpointCursor: v.optional(v.string()),
    hasRemainingRequests: v.optional(v.boolean()),
  },
  handler: async (ctx, { userId, endpointCursor, hasRemainingRequests = false }) => {
    const ENDPOINT_PAGE_SIZE = 20;

    const endpointResult = await ctx.db
      .query("endpoints")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .paginate({ cursor: endpointCursor ?? null, numItems: ENDPOINT_PAGE_SIZE });

    let deleted = 0;
    let needsMoreRequests = hasRemainingRequests;

    for (const endpoint of endpointResult.page) {
      const requests = await ctx.db
        .query("requests")
        .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
        .take(CLEANUP_BATCH_SIZE);

      for (const req of requests) {
        await ctx.db.delete(req._id);
        deleted++;
      }

      if (requests.length > 0) {
        await ctx.scheduler.runAfter(0, internal.requests.decrementRequestCount, {
          endpointId: endpoint._id,
          count: requests.length,
        });
      }

      if (requests.length === CLEANUP_BATCH_SIZE) {
        needsMoreRequests = true;
      }
    }

    // More endpoints to process — continue to next page
    if (!endpointResult.isDone) {
      await ctx.scheduler.runAfter(0, internal.requests.cleanupUserRequests, {
        userId,
        endpointCursor: endpointResult.continueCursor,
        hasRemainingRequests: needsMoreRequests,
      });
      return { deleted, complete: false };
    }

    // All endpoints visited. If any had remaining requests, do another full pass.
    if (needsMoreRequests) {
      await ctx.scheduler.runAfter(0, internal.requests.cleanupUserRequests, {
        userId,
      });
      return { deleted, complete: false };
    }

    return { deleted, complete: true };
  },
});

// Delete requests older than 7 days for free users.
// Runs daily to enforce free-tier retention.
// Uses pagination to process all free users across multiple cron invocations.
// Schedules cleanupOldRequestsForUser when:
// - user has >20 endpoints, or
// - any endpoint still has at least one full stale request batch remaining.
export const cleanupOldFreeRequests = internalMutation({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { cursor }) => {
    const cutoff = Date.now() - FREE_REQUEST_RETENTION_MS;

    // Use index for efficient lookup and paginate through users
    const result = await ctx.db
      .query("users")
      .withIndex("by_plan", (q) => q.eq("plan", "free"))
      .paginate({ cursor: cursor ?? null, numItems: 5 });

    let totalDeleted = 0;
    let scheduledFollowups = 0;
    for (const user of result.page) {
      // Paginate endpoints to detect overflow beyond first page
      const endpointResult = await ctx.db
        .query("endpoints")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .paginate({ cursor: null, numItems: 20 });

      let needsMoreRequests = false;
      for (const endpoint of endpointResult.page) {
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

        if (oldRequests.length > 0) {
          await ctx.scheduler.runAfter(0, internal.requests.decrementRequestCount, {
            endpointId: endpoint._id,
            count: oldRequests.length,
          });
        }

        // If we consumed a full batch, there may be more stale rows on this endpoint.
        if (oldRequests.length === CLEANUP_BATCH_SIZE) {
          needsMoreRequests = true;
        }
      }

      // Schedule dedicated cleanup when endpoint pagination overflows, or when any endpoint
      // still has at least one full stale batch remaining.
      if (!endpointResult.isDone || needsMoreRequests) {
        await ctx.scheduler.runAfter(0, internal.requests.cleanupOldRequestsForUser, {
          userId: user._id,
          endpointCursor: endpointResult.isDone ? undefined : endpointResult.continueCursor,
          hasRemainingRequests: needsMoreRequests,
          cutoffMs: cutoff,
        });
        scheduledFollowups++;
      }
    }

    // Schedule continuation if there are more users
    if (!result.isDone) {
      await ctx.scheduler.runAfter(100, internal.requests.cleanupOldFreeRequests, {
        cursor: result.continueCursor,
      });
    }

    return { deleted: totalDeleted, done: result.isDone, scheduledFollowups };
  },
});

// Delete requests older than 30 days for pro users.
// Runs daily to enforce retention policy.
// Uses pagination to process all pro users across multiple cron invocations.
// Schedules cleanupOldRequestsForUser when:
// - user has >20 endpoints, or
// - any endpoint still has at least one full stale request batch remaining.
// User page size kept small (5) to stay within Convex's 16K write limit per mutation
// (worst case: 5 users × 20 endpoints × 100 requests = 10,000 writes).
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
      .paginate({ cursor: cursor ?? null, numItems: 5 });

    let totalDeleted = 0;
    for (const user of result.page) {
      // Paginate endpoints to detect overflow beyond first page
      const endpointResult = await ctx.db
        .query("endpoints")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .paginate({ cursor: null, numItems: 20 });

      let needsMoreRequests = false;
      for (const endpoint of endpointResult.page) {
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

        if (oldRequests.length > 0) {
          await ctx.scheduler.runAfter(0, internal.requests.decrementRequestCount, {
            endpointId: endpoint._id,
            count: oldRequests.length,
          });
        }

        // If we consumed a full batch, there may be more stale rows on this endpoint.
        if (oldRequests.length === CLEANUP_BATCH_SIZE) {
          needsMoreRequests = true;
        }
      }

      // Schedule dedicated cleanup when endpoint pagination overflows, or when any endpoint
      // still has at least one full stale batch remaining.
      if (!endpointResult.isDone || needsMoreRequests) {
        await ctx.scheduler.runAfter(0, internal.requests.cleanupOldRequestsForUser, {
          userId: user._id,
          endpointCursor: endpointResult.isDone ? undefined : endpointResult.continueCursor,
          hasRemainingRequests: needsMoreRequests,
          cutoffMs: cutoff,
        });
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

// Clean up old requests for a single user's endpoints beyond the first page.
// Scheduled by cleanupOldRequests/cleanupOldFreeRequests when a user has >20 endpoints.
// Tracks whether any endpoint had remaining stale requests and does a full re-pass.
export const cleanupOldRequestsForUser = internalMutation({
  args: {
    userId: v.id("users"),
    endpointCursor: v.optional(v.string()),
    hasRemainingRequests: v.optional(v.boolean()),
    cutoffMs: v.optional(v.number()),
  },
  handler: async (ctx, { userId, endpointCursor, hasRemainingRequests = false, cutoffMs }) => {
    const cutoff = cutoffMs ?? Date.now() - PRO_REQUEST_RETENTION_MS;
    const ENDPOINT_PAGE_SIZE = 20;

    const endpointResult = await ctx.db
      .query("endpoints")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .paginate({ cursor: endpointCursor ?? null, numItems: ENDPOINT_PAGE_SIZE });

    let deleted = 0;
    let needsMoreRequests = hasRemainingRequests;

    for (const endpoint of endpointResult.page) {
      const oldRequests = await ctx.db
        .query("requests")
        .withIndex("by_endpoint_time", (q) =>
          q.eq("endpointId", endpoint._id).lt("receivedAt", cutoff)
        )
        .take(CLEANUP_BATCH_SIZE);

      for (const req of oldRequests) {
        await ctx.db.delete(req._id);
        deleted++;
      }

      if (oldRequests.length > 0) {
        await ctx.scheduler.runAfter(0, internal.requests.decrementRequestCount, {
          endpointId: endpoint._id,
          count: oldRequests.length,
        });
      }

      if (oldRequests.length === CLEANUP_BATCH_SIZE) {
        needsMoreRequests = true;
      }
    }

    // More endpoints to process — continue to next page
    if (!endpointResult.isDone) {
      await ctx.scheduler.runAfter(0, internal.requests.cleanupOldRequestsForUser, {
        userId,
        endpointCursor: endpointResult.continueCursor,
        hasRemainingRequests: needsMoreRequests,
        cutoffMs: cutoff,
      });
      return { deleted, done: false };
    }

    // All endpoints visited. If any had remaining old requests, do another full pass.
    if (needsMoreRequests) {
      await ctx.scheduler.runAfter(100, internal.requests.cleanupOldRequestsForUser, {
        userId,
        cutoffMs: cutoff,
      });
      return { deleted, done: false };
    }

    return { deleted, done: true };
  },
});

// One-time migration: backfill requestCount on all endpoints.
// Run once post-deploy via: npx convex run internal.requests.migrateRequestCounts '{}'
// Safe to re-run. Remove after migration is complete.
export const migrateRequestCounts = internalMutation({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { cursor }) => {
    const PAGE_SIZE = 50;
    const result = await ctx.db
      .query("endpoints")
      .paginate({ cursor: cursor ?? null, numItems: PAGE_SIZE });

    let updated = 0;
    for (const endpoint of result.page) {
      const requests = await ctx.db
        .query("requests")
        .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
        .take(1001);
      const count = Math.min(requests.length, 1000);
      if (count !== (endpoint.requestCount ?? 0)) {
        await ctx.db.patch(endpoint._id, { requestCount: count });
        updated++;
      }
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.requests.migrateRequestCounts, {
        cursor: result.continueCursor,
      });
    }

    return { updated, done: result.isDone };
  },
});
