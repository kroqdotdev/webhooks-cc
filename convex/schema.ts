/**
 * @fileoverview Database schema for webhooks.cc.
 *
 * Index documentation:
 * - users.by_email: Lookup user by OAuth email during authentication
 * - users.by_polar_customer: Find user when processing Polar webhooks
 * - apiKeys.by_key_hash: Validate API keys in O(1) time
 * - apiKeys.by_user: List API keys for a user's settings page
 * - endpoints.by_slug: Resolve endpoint from webhook URL path
 * - endpoints.by_user: List endpoints for dashboard
 * - endpoints.by_expires: Find expired ephemeral endpoints for cleanup cron
 * - requests.by_endpoint_time: List requests for an endpoint, sorted by time
 */
import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,

  users: defineTable({
    // OAuth fields
    email: v.string(),
    name: v.optional(v.string()),
    image: v.optional(v.string()),

    // Subscription: "free" | "pro" | "enterprise" (future)
    plan: v.union(v.literal("free"), v.literal("pro")),
    polarCustomerId: v.optional(v.string()),
    polarSubscriptionId: v.optional(v.string()),
    // Subscription state: active (paying), canceled (downgrading), past_due (payment failed)
    subscriptionStatus: v.optional(
      v.union(v.literal("active"), v.literal("canceled"), v.literal("past_due"))
    ),

    // Billing period
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),

    // Usage
    requestsUsed: v.number(),
    requestLimit: v.number(),

    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_polar_customer", ["polarCustomerId"]),

  apiKeys: defineTable({
    userId: v.id("users"),
    keyHash: v.string(),
    keyPrefix: v.string(),
    name: v.string(),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_key_hash", ["keyHash"])
    .index("by_user", ["userId"]),

  endpoints: defineTable({
    userId: v.optional(v.id("users")),
    slug: v.string(),
    name: v.optional(v.string()),
    mockResponse: v.optional(
      v.object({
        status: v.number(),
        body: v.string(),
        headers: v.record(v.string(), v.string()),
      })
    ),
    isEphemeral: v.boolean(),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_user", ["userId"])
    .index("by_expires", ["expiresAt"]),

  requests: defineTable({
    endpointId: v.id("endpoints"),
    method: v.string(),
    path: v.string(),
    headers: v.record(v.string(), v.string()),
    body: v.optional(v.string()),
    queryParams: v.record(v.string(), v.string()),
    contentType: v.optional(v.string()),
    ip: v.string(),
    size: v.number(),
    receivedAt: v.number(),
  }).index("by_endpoint_time", ["endpointId", "receivedAt"]),
});
