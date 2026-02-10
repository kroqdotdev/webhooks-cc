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
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { customAlphabet } from "nanoid";

// Generate unbiased random API key using nanoid (avoids modulo bias from Math.random)
const generateApiKeyBody = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);

/** Generates a new API key with the whcc_ prefix. */
export function generateApiKey(): string {
  return `whcc_${generateApiKeyBody()}`;
}

/** Produces a SHA-256 hash of the API key for secure storage. */
export async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Maximum length for API key names
const MAX_NAME_LENGTH = 100;
// Maximum number of API keys per user
export const MAX_KEYS_PER_USER = 10;

export const create = mutation({
  args: {
    name: v.string(),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, { name, expiresAt }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Validate expiresAt if provided
    if (expiresAt !== undefined) {
      const now = Date.now();
      if (expiresAt <= now) {
        throw new Error("Expiration must be in the future");
      }
      const MAX_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
      if (expiresAt > now + MAX_LIFETIME_MS) {
        throw new Error("Expiration cannot be more than 1 year from now");
      }
    }

    // Validate name
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > MAX_NAME_LENGTH) {
      throw new Error(`API key name must be between 1 and ${MAX_NAME_LENGTH} characters`);
    }

    // Enforce per-user key limit
    const existingKeys = await ctx.db
      .query("apiKeys")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_KEYS_PER_USER + 1);
    if (existingKeys.length >= MAX_KEYS_PER_USER) {
      throw new Error(`Maximum of ${MAX_KEYS_PER_USER} API keys allowed per user`);
    }

    const apiKey = generateApiKey();
    const keyHash = await hashKey(apiKey);
    const keyPrefix = apiKey.slice(0, 12);

    await ctx.db.insert("apiKeys", {
      userId,
      keyHash,
      keyPrefix,
      name: trimmedName,
      expiresAt,
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
      .take(MAX_KEYS_PER_USER);

    // Return only safe fields (not the hash)
    return keys.map((key) => ({
      _id: key._id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
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

    // Reject expired keys (cron handles actual deletion)
    if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) return null;

    // Update last used timestamp
    await ctx.db.patch(apiKey._id, { lastUsedAt: Date.now() });

    return { userId: apiKey.userId };
  },
});

/**
 * Read-only API key validation. Returns userId and metadata without writing.
 * Used by HTTP action for fast validation; updateLastUsed called separately.
 */
export const validateQuery = internalQuery({
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

    if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) return null;

    return { userId: apiKey.userId, apiKeyId: apiKey._id, lastUsedAt: apiKey.lastUsedAt };
  },
});

/**
 * Update the lastUsedAt timestamp on an API key. Fire-and-forget.
 */
export const updateLastUsed = internalMutation({
  args: {
    apiKeyId: v.id("apiKeys"),
  },
  handler: async (ctx, { apiKeyId }) => {
    const apiKey = await ctx.db.get(apiKeyId);
    if (apiKey) {
      await ctx.db.patch(apiKeyId, { lastUsedAt: Date.now() });
    }
  },
});

/**
 * Clean up expired API keys. Called by daily cron.
 * Processes up to 100 keys per run to avoid timeout.
 */
export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Use gt(0) as lower bound to exclude undefined values (which sort before numbers in Convex)
    const expired = await ctx.db
      .query("apiKeys")
      .withIndex("by_expires", (q) => q.gt("expiresAt", 0).lt("expiresAt", now))
      .take(100);

    for (const key of expired) {
      await ctx.db.delete(key._id);
    }

    // If we hit the batch limit, reschedule to process remaining
    if (expired.length === 100) {
      await ctx.scheduler.runAfter(100, internal.apiKeys.cleanupExpired, {});
    }

    return { deleted: expired.length };
  },
});
