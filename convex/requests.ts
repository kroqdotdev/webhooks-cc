import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

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

    // Note: Quota limits are now enforced by the Go receiver via the quota cache.
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
// Returns remaining quota, limit, and period end for caching in the receiver.
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
      return { error: "not_found" };
    }

    // Ephemeral endpoints or endpoints without a user are unlimited
    if (endpoint.isEphemeral || !endpoint.userId) {
      return {
        userId: null,
        remaining: -1,
        limit: -1,
        periodEnd: null,
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
      };
    }

    return {
      userId: endpoint.userId,
      remaining: Math.max(0, user.requestLimit - user.requestsUsed),
      limit: user.requestLimit,
      periodEnd: user.periodEnd ?? null,
    };
  },
});

// Increment user's request usage counter.
// Called via scheduler from capture to avoid OCC conflicts.
// Supports batch increments via the count parameter.
export const incrementUsage = internalMutation({
  args: {
    userId: v.id("users"),
    count: v.optional(v.number()),
  },
  handler: async (ctx, { userId, count = 1 }) => {
    const user = await ctx.db.get(userId);
    if (user) {
      await ctx.db.patch(userId, {
        requestsUsed: user.requestsUsed + count,
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

// Maximum number of requests that can be fetched at once
const MAX_LIST_LIMIT = 100;

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
