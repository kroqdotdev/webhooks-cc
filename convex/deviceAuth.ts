/**
 * @fileoverview OAuth device flow for CLI authentication.
 *
 * Flow:
 * 1. CLI calls createDeviceCode -> gets deviceCode + userCode
 * 2. User opens browser, enters userCode on /cli/verify
 * 3. Browser calls authorizeDeviceCode -> generates API key, stores on device code doc
 * 4. CLI polls pollDeviceCode until status is "authorized"
 * 5. CLI calls claimDeviceCode -> gets API key, device code doc is deleted
 *
 * Device codes expire after 15 minutes. Expired codes are cleaned up by cron.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { generateApiKey, hashKey } from "./apiKeys";
import { customAlphabet } from "nanoid";

const DEVICE_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Alphanumeric for device codes (URL-safe, no ambiguous chars)
const generateDeviceCode = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);

// Uppercase alphanumeric for user codes (easy to type, no ambiguous chars like 0/O, 1/I/L)
const generateUserCodePart = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 4);

export const createDeviceCode = mutation({
  args: {},
  handler: async (ctx) => {
    const deviceCode = generateDeviceCode();
    const userCode = `${generateUserCodePart()}-${generateUserCodePart()}`;
    const expiresAt = Date.now() + DEVICE_CODE_TTL_MS;

    await ctx.db.insert("deviceCodes", {
      deviceCode,
      userCode,
      expiresAt,
      status: "pending",
    });

    return {
      deviceCode,
      userCode,
      expiresAt,
    };
  },
});

export const authorizeDeviceCode = mutation({
  args: {
    userCode: v.string(),
  },
  handler: async (ctx, { userCode }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const code = await ctx.db
      .query("deviceCodes")
      .withIndex("by_user_code", (q) => q.eq("userCode", userCode.toUpperCase()))
      .first();

    if (!code) throw new Error("Invalid code");
    if (code.expiresAt < Date.now()) throw new Error("Code expired");
    if (code.status === "authorized") throw new Error("Code already used");

    // Generate an API key for the CLI
    const rawKey = generateApiKey();
    const keyHash = await hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12);

    // Store the API key hash in the apiKeys table
    await ctx.db.insert("apiKeys", {
      userId,
      keyHash,
      keyPrefix,
      name: "CLI (device auth)",
      createdAt: Date.now(),
    });

    // Get user info for the CLI
    const user = await ctx.db.get(userId);

    // Mark device code as authorized and store the raw key for one-time claim
    await ctx.db.patch(code._id, {
      status: "authorized",
      userId,
      apiKey: rawKey,
    });

    return {
      success: true,
      email: user?.email,
    };
  },
});

export const pollDeviceCode = query({
  args: {
    deviceCode: v.string(),
  },
  handler: async (ctx, { deviceCode }) => {
    const code = await ctx.db
      .query("deviceCodes")
      .withIndex("by_device_code", (q) => q.eq("deviceCode", deviceCode))
      .first();

    if (!code) return { status: "expired" as const };
    if (code.expiresAt < Date.now()) return { status: "expired" as const };

    return { status: code.status };
  },
});

export const claimDeviceCode = mutation({
  args: {
    deviceCode: v.string(),
  },
  handler: async (ctx, { deviceCode }) => {
    const code = await ctx.db
      .query("deviceCodes")
      .withIndex("by_device_code", (q) => q.eq("deviceCode", deviceCode))
      .first();

    if (!code) throw new Error("Invalid or expired code");
    if (code.expiresAt < Date.now()) throw new Error("Code expired");
    if (code.status !== "authorized") throw new Error("Code not yet authorized");
    if (!code.apiKey || !code.userId) throw new Error("Code not properly authorized");

    // Get user info
    const user = await ctx.db.get(code.userId);

    // Delete the device code (one-time use)
    await ctx.db.delete(code._id);

    return {
      apiKey: code.apiKey,
      userId: code.userId,
      email: user?.email ?? "",
    };
  },
});

export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("deviceCodes")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(100);

    for (const code of expired) {
      await ctx.db.delete(code._id);
    }

    return { deleted: expired.length };
  },
});
