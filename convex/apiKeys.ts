import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let key = "whcc_";
  for (let i = 0; i < 32; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const create = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const apiKey = generateApiKey();
    const keyHash = await hashKey(apiKey);
    const keyPrefix = apiKey.slice(0, 12);

    await ctx.db.insert("apiKeys", {
      userId,
      keyHash,
      keyPrefix,
      name,
      createdAt: Date.now(),
    });

    // Return the full key only once - it won't be retrievable again
    return { key: apiKey };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    // Return only safe fields (not the hash)
    return keys.map((key) => ({
      _id: key._id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
    }));
  },
});

export const revoke = mutation({
  args: {
    id: v.id("apiKeys"),
  },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const apiKey = await ctx.db.get(id);
    if (!apiKey) throw new Error("API key not found");
    if (apiKey.userId !== userId) throw new Error("Not authorized");

    await ctx.db.delete(id);
    return { success: true };
  },
});

// Validate an API key (for internal use)
export const validate = mutation({
  args: {
    key: v.string(),
  },
  handler: async (ctx, { key }) => {
    const keyHash = await hashKey(key);

    const apiKey = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
      .first();

    if (!apiKey) return null;

    // Update last used timestamp
    await ctx.db.patch(apiKey._id, { lastUsedAt: Date.now() });

    return { userId: apiKey.userId };
  },
});
