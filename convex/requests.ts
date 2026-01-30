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

export const list = query({
  args: {
    endpointId: v.id("endpoints"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { endpointId, limit = 50 }) => {
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
      .take(limit);

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

// Cleanup expired ephemeral endpoints and their requests
export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const expired = await ctx.db
      .query("endpoints")
      .withIndex("by_expires")
      .filter((q) => q.and(q.neq(q.field("expiresAt"), undefined), q.lt(q.field("expiresAt"), now)))
      .take(100);

    for (const endpoint of expired) {
      // Delete requests
      const requests = await ctx.db
        .query("requests")
        .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
        .collect();

      for (const request of requests) {
        await ctx.db.delete(request._id);
      }

      // Delete endpoint
      await ctx.db.delete(endpoint._id);
    }

    return { deleted: expired.length };
  },
});
