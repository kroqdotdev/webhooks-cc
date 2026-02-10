/**
 * @fileoverview Webhook endpoint CRUD operations.
 *
 * Authorization rules (three-tier):
 * 1. Ephemeral endpoints: Viewable by anyone (for live demo)
 * 2. Owned endpoints: Only viewable/editable by the owner
 * 3. Unowned non-ephemeral: Should not exist; denied if found
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { GenericDatabaseReader } from "convex/server";
import { v } from "convex/values";
import {
  mutation,
  query,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";
import { nanoid } from "nanoid";
import { EPHEMERAL_TTL_MS, MAX_EPHEMERAL_ENDPOINTS } from "./config";
import { rateLimiter } from "./rateLimiter";

// Maximum length for endpoint names
const MAX_NAME_LENGTH = 100;
// Maximum attempts to generate a unique slug
const MAX_SLUG_ATTEMPTS = 5;
// Maximum endpoints returned by public list query
const MAX_LIST_RESULTS = 100;

/** Generate a unique slug with collision checking. */
async function generateUniqueSlug(db: GenericDatabaseReader<DataModel>): Promise<string> {
  for (let i = 0; i < MAX_SLUG_ATTEMPTS; i++) {
    const candidate = nanoid(8);
    const existing = await db
      .query("endpoints")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .first();
    if (!existing) return candidate;
  }
  throw new Error("Failed to generate unique slug, please try again");
}

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

    // Rate limit endpoint creation
    const rateLimitResult = await rateLimiter.limit(
      ctx,
      userId ? "endpointCreationUser" : "endpointCreationAnon",
      { key: userId ?? "global" }
    );
    if (!rateLimitResult.ok) {
      throw new Error("Rate limit exceeded. Please try again later.");
    }

    // Validate name length if provided
    if (args.name !== undefined) {
      const trimmedName = args.name.trim();
      if (trimmedName.length === 0 || trimmedName.length > MAX_NAME_LENGTH) {
        throw new Error(`Endpoint name must be between 1 and ${MAX_NAME_LENGTH} characters`);
      }
    }

    // Validate mock response status code if provided (must be integer between 100-599)
    if (args.mockResponse) {
      const status = args.mockResponse.status;
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error("Mock response status must be an integer between 100 and 599");
      }
    }

    const slug = await generateUniqueSlug(ctx.db);

    // Unauthenticated users must always create ephemeral endpoints
    const isEphemeral = !userId ? true : (args.isEphemeral ?? false);

    // Global cap on active ephemeral endpoints to prevent abuse
    if (isEphemeral) {
      const activeEphemeral = await ctx.db
        .query("endpoints")
        .withIndex("by_ephemeral_expires", (q) =>
          q.eq("isEphemeral", true).gt("expiresAt", Date.now())
        )
        .take(MAX_EPHEMERAL_ENDPOINTS + 1);
      if (activeEphemeral.length > MAX_EPHEMERAL_ENDPOINTS) {
        throw new Error("Too many active demo endpoints. Please try again later.");
      }
    }

    const endpointId = await ctx.db.insert("endpoints", {
      userId,
      slug,
      name: args.name?.trim(),
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

    return await ctx.db
      .query("endpoints")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_LIST_RESULTS);
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
      v.union(
        v.object({
          status: v.number(),
          body: v.string(),
          headers: v.record(v.string(), v.string()),
        }),
        v.null()
      )
    ),
  },
  handler: async (ctx, { id, name, mockResponse }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const endpoint = await ctx.db.get(id);
    if (!endpoint) throw new Error("Endpoint not found");
    if (endpoint.userId !== userId) {
      throw new Error("Not authorized");
    }

    // Validate name length if provided
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName.length === 0 || trimmedName.length > MAX_NAME_LENGTH) {
        throw new Error(`Endpoint name must be between 1 and ${MAX_NAME_LENGTH} characters`);
      }
    }

    // Validate mock response status code if provided (must be integer between 100-599)
    if (mockResponse) {
      const status = mockResponse.status;
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error("Mock response status must be an integer between 100 and 599");
      }
    }

    await ctx.db.patch(id, {
      ...(name !== undefined && { name: name.trim() }),
      // null clears the mock response; undefined means no change
      ...(mockResponse !== undefined && {
        mockResponse: mockResponse === null ? undefined : mockResponse,
      }),
    });

    // Invalidate receiver cache so the new mock response takes effect quickly.
    // 2s delay ensures the mutation's write is fully committed and visible
    // to Convex queries before the receiver re-fetches endpoint info.
    if (mockResponse !== undefined) {
      await ctx.scheduler.runAfter(2000, internal.endpoints.invalidateReceiverCache, {
        slug: endpoint.slug,
      });
    }

    return { success: true };
  },
});

/** Notify the receiver to evict its cached endpoint info for a slug. */
export const invalidateReceiverCache = internalAction({
  args: { slug: v.string() },
  handler: async (_ctx, { slug }) => {
    const receiverUrl = process.env.RECEIVER_URL;
    const secret = process.env.CAPTURE_SHARED_SECRET;
    if (!receiverUrl || !secret) return;

    try {
      const res = await fetch(
        `${receiverUrl}/internal/cache-invalidate/${encodeURIComponent(slug)}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}` },
        }
      );
      if (!res.ok) {
        console.warn(`Cache invalidation failed for ${slug}: ${res.status}`);
      }
    } catch (err) {
      // Best-effort: cache will expire on its own after TTL
      console.warn(`Cache invalidation request failed for ${slug}:`, err);
    }
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

    // Delete endpoint immediately so it disappears from the UI
    await ctx.db.delete(id);

    // If more requests remain, schedule async drain
    if (requests.length === DELETE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.requests.drainOrphanedRequests, {
        endpointId: id,
      });
    }

    return { success: true };
  },
});

// --- Internal functions for CLI API routes ---

export const listByUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("endpoints")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(100);
  },
});

export const getBySlugForUser = internalQuery({
  args: { slug: v.string(), userId: v.id("users") },
  handler: async (ctx, { slug, userId }) => {
    const endpoint = await ctx.db
      .query("endpoints")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!endpoint) return null;
    if (endpoint.userId !== userId) return null;

    return endpoint;
  },
});

export const createForUser = internalMutation({
  args: { userId: v.id("users"), name: v.optional(v.string()) },
  handler: async (ctx, { userId, name }) => {
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName.length === 0 || trimmedName.length > MAX_NAME_LENGTH) {
        throw new Error(`Endpoint name must be between 1 and ${MAX_NAME_LENGTH} characters`);
      }
    }

    const slug = await generateUniqueSlug(ctx.db);
    const createdAt = Date.now();

    const endpointId = await ctx.db.insert("endpoints", {
      userId,
      slug,
      name: name?.trim(),
      isEphemeral: false,
      createdAt,
    });

    return { id: endpointId, slug, name: name?.trim(), createdAt };
  },
});

export const removeForUser = internalMutation({
  args: { slug: v.string(), userId: v.id("users") },
  handler: async (ctx, { slug, userId }) => {
    const endpoint = await ctx.db
      .query("endpoints")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!endpoint) return { success: true, alreadyDeleted: true };
    if (endpoint.userId !== userId) throw new Error("Not authorized");

    // Delete requests in batches
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
      .take(DELETE_BATCH_SIZE);

    for (const request of requests) {
      await ctx.db.delete(request._id);
    }

    // Delete endpoint immediately so it disappears from the UI/API
    await ctx.db.delete(endpoint._id);

    // If more requests remain, schedule async drain
    if (requests.length === DELETE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.requests.drainOrphanedRequests, {
        endpointId: endpoint._id,
      });
    }

    return { success: true };
  },
});
