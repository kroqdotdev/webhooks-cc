/**
 * @fileoverview API key management for programmatic access to webhooks.cc.
 *
 * Security design:
 * - Keys use nanoid with a custom alphabet to avoid modulo bias
 * - Only the SHA-256 hash is stored; the plaintext key is shown once at creation
 * - Keys use prefix "whcc_" for identification; first 12 chars stored for display
 * - Validation uses the hash index for O(1) lookup
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { customAlphabet } from "nanoid";

// Generate unbiased random API key using nanoid (avoids modulo bias from Math.random)
const generateApiKeyBody = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);

/** Generates a new API key with the whcc_ prefix. */
function generateApiKey(): string {
  return `whcc_${generateApiKeyBody()}`;
}

/** Produces a SHA-256 hash of the API key for secure storage. */
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

/**
 * Validates an API key and updates its last-used timestamp.
 * Internal use only - called from HTTP actions after extracting the key from headers.
 */
export const validate = internalMutation({
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
