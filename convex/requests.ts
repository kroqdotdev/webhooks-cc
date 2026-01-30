import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query, internalMutation } from "./_generated/server";

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

    // Check user limits if not ephemeral
    if (endpoint.userId) {
      const user = await ctx.db.get(endpoint.userId);
      if (user && user.requestsUsed >= user.requestLimit) {
        return { error: "limit_exceeded" };
      }

      // Increment usage - Convex mutations are already atomic/serializable
      if (user) {
        await ctx.db.patch(endpoint.userId, {
          requestsUsed: user.requestsUsed + 1,
        });
      }
    }

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
