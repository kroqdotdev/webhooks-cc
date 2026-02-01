/**
 * @fileoverview Webhook endpoint CRUD operations.
 *
 * Authorization rules (three-tier):
 * 1. Ephemeral endpoints: Viewable by anyone (for live demo)
 * 2. Owned endpoints: Only viewable/editable by the owner
 * 3. Unowned non-ephemeral: Should not exist; denied if found
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { nanoid } from "nanoid";
import { EPHEMERAL_TTL_MS } from "./config";

export const create = mutation({
  args: {
    name: v.optional(v.string()),
    mockResponse: v.optional(
      v.object({
        status: v.number(),
        body: v.string(),
        headers: v.record(v.string(), v.string()),
      })
    ),
    isEphemeral: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = (await getAuthUserId(ctx)) ?? undefined;

    const slug = nanoid(8);
    const isEphemeral = args.isEphemeral ?? !userId;

    const endpointId = await ctx.db.insert("endpoints", {
      userId,
      slug,
      name: args.name,
      mockResponse: args.mockResponse,
      isEphemeral,
      expiresAt: isEphemeral ? Date.now() + EPHEMERAL_TTL_MS : undefined,
      createdAt: Date.now(),
    });

    // URL is constructed client-side using NEXT_PUBLIC_WEBHOOK_URL
    return {
      id: endpointId,
      slug,
    };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const endpoints = await ctx.db
      .query("endpoints")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();

    return endpoints;
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const userId = await getAuthUserId(ctx);
    const endpoint = await ctx.db
      .query("endpoints")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!endpoint) return null;

    // Authorization rules:
    // 1. Ephemeral endpoints can be viewed by anyone (for the live demo)
    // 2. Endpoints with an owner can only be viewed by that owner
    // 3. Unowned non-ephemeral endpoints should not exist, but if they do, deny access
    if (endpoint.isEphemeral) {
      return endpoint;
    }

    // For non-ephemeral endpoints, require ownership
    if (!endpoint.userId || !userId || endpoint.userId !== userId) {
      return null;
    }

    return endpoint;
  },
});

export const get = query({
  args: { id: v.id("endpoints") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    const endpoint = await ctx.db.get(id);

    if (!endpoint) return null;

    // Authorization rules:
    // 1. Ephemeral endpoints can be viewed by anyone
    // 2. Endpoints with an owner can only be viewed by that owner
    // 3. Unowned non-ephemeral endpoints should not exist, but if they do, deny access
    if (endpoint.isEphemeral) {
      return endpoint;
    }

    // For non-ephemeral endpoints, require ownership
    if (!endpoint.userId || !userId || endpoint.userId !== userId) {
      return null;
    }

    return endpoint;
  },
});

export const update = mutation({
  args: {
    id: v.id("endpoints"),
    name: v.optional(v.string()),
    mockResponse: v.optional(
      v.object({
        status: v.number(),
        body: v.string(),
        headers: v.record(v.string(), v.string()),
      })
    ),
  },
  handler: async (ctx, { id, ...updates }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const endpoint = await ctx.db.get(id);
    if (!endpoint) throw new Error("Endpoint not found");
    if (endpoint.userId !== userId) {
      throw new Error("Not authorized");
    }

    await ctx.db.patch(id, updates);
    return { success: true };
  },
});

// Delete at most 100 requests per mutation to avoid Convex timeout (10s limit)
const DELETE_BATCH_SIZE = 100;

export const remove = mutation({
  args: { id: v.id("endpoints") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const endpoint = await ctx.db.get(id);
    if (!endpoint) throw new Error("Endpoint not found");
    if (endpoint.userId !== userId) {
      throw new Error("Not authorized");
    }

    // Delete requests in batches to avoid timeout
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_endpoint_time", (q) => q.eq("endpointId", id))
      .take(DELETE_BATCH_SIZE);

    for (const request of requests) {
      await ctx.db.delete(request._id);
    }

    // If there might be more requests, the endpoint stays but requests are being cleaned
    // For simplicity, we delete the endpoint now - orphaned requests will be cleaned by cron
    await ctx.db.delete(id);
    return { success: true };
  },
});
