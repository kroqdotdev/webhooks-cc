import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";

export const capture = mutation({
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

      // Increment usage with TOCTOU protection:
      // Re-read user to get latest requestsUsed value before incrementing
      if (user) {
        const freshUser = await ctx.db.get(endpoint.userId);
        if (freshUser) {
          await ctx.db.patch(endpoint.userId, {
            requestsUsed: freshUser.requestsUsed + 1,
          });
        }
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
    return await ctx.db.get(id);
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
      .filter((q) =>
        q.and(
          q.neq(q.field("expiresAt"), undefined),
          q.lt(q.field("expiresAt"), now)
        )
      )
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
