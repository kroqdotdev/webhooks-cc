/**
 * Internal functions for load testing the receiver.
 * These are ONLY callable via `npx convex run` (not exposed over HTTP).
 * Mutations are guarded against accidental production use.
 *
 * Usage:
 *   npx convex run loadTest:seed '{}'
 *   npx convex run loadTest:verify '{}'
 *   npx convex run loadTest:cleanup '{}'
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { nanoid } from "nanoid";

function assertNotProduction() {
  const deployment = process.env.CONVEX_CLOUD_URL ?? "";
  if (deployment.includes("prod:") || deployment.includes("affable-corgi")) {
    throw new Error("Load test functions cannot run in production");
  }
}

const TEST_USER_COUNT = 500;
const ENDPOINTS_PER_USER = 2;
const REQUEST_LIMIT_PER_USER = 100;
const TEST_EMAIL_PREFIX = "loadtest-";
const TEST_EMAIL_DOMAIN = "@test.webhooks.cc";

/**
 * Seed test data: 500 users with 2 endpoints each.
 * Users get a request limit of 100 with an active period.
 * Returns a map of slug -> { userId, endpointId } for the test harness.
 *
 * Must be called in batches due to Convex 10s mutation timeout.
 */
export const seedBatch = internalMutation({
  args: {
    batchIndex: v.number(),
    batchSize: v.number(),
  },
  handler: async (ctx, { batchIndex, batchSize }) => {
    assertNotProduction();
    const startIdx = batchIndex * batchSize;
    const endIdx = Math.min(startIdx + batchSize, TEST_USER_COUNT);
    const results: Array<{
      userId: string;
      email: string;
      slugs: string[];
      endpointIds: string[];
    }> = [];

    const now = Date.now();
    const periodEnd = now + 24 * 60 * 60 * 1000; // 24h from now

    for (let i = startIdx; i < endIdx; i++) {
      const email = `${TEST_EMAIL_PREFIX}${i}${TEST_EMAIL_DOMAIN}`;

      // Check if user already exists (idempotent)
      const existing = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();

      let userId: Id<"users">;
      if (existing) {
        userId = existing._id;
        // Reset usage
        await ctx.db.patch(existing._id, {
          requestsUsed: 0,
          requestLimit: REQUEST_LIMIT_PER_USER,
          periodStart: now,
          periodEnd,
        });
      } else {
        userId = await ctx.db.insert("users", {
          email,
          name: `Load Test User ${i}`,
          plan: "free",
          requestsUsed: 0,
          requestLimit: REQUEST_LIMIT_PER_USER,
          periodStart: now,
          periodEnd,
          createdAt: now,
        });
      }

      const slugs: string[] = [];
      const endpointIds: Id<"endpoints">[] = [];

      for (let j = 0; j < ENDPOINTS_PER_USER; j++) {
        const slug = `lt-${i}-${j}-${nanoid(4)}`;

        // Check if this user already has enough endpoints
        const existingEndpoints = await ctx.db
          .query("endpoints")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(ENDPOINTS_PER_USER + 1);

        // Reuse existing if we already have them
        if (existingEndpoints.length > j) {
          slugs.push(existingEndpoints[j].slug);
          endpointIds.push(existingEndpoints[j]._id);
          continue;
        }

        const endpointId = await ctx.db.insert("endpoints", {
          userId: userId,
          slug,
          name: `Load Test Endpoint ${i}-${j}`,
          isEphemeral: false,
          createdAt: now,
        });

        slugs.push(slug);
        endpointIds.push(endpointId);
      }

      results.push({ userId, email, slugs, endpointIds });
    }

    return results;
  },
});

/**
 * Orchestrate seeding across multiple batches.
 */
export const seed = internalAction({
  args: {},
  handler: async (ctx) => {
    assertNotProduction();
    const batchSize = 25; // 25 users per batch to stay under 10s
    const batches = Math.ceil(TEST_USER_COUNT / batchSize);
    const allResults: Array<{
      userId: string;
      email: string;
      slugs: string[];
      endpointIds: string[];
    }> = [];

    for (let i = 0; i < batches; i++) {
      const batch = await ctx.runMutation(internal.loadTest.seedBatch, {
        batchIndex: i,
        batchSize,
      });
      allResults.push(...batch);

      if ((i + 1) % 5 === 0) {
        console.log(
          `Seeded ${Math.min((i + 1) * batchSize, TEST_USER_COUNT)}/${TEST_USER_COUNT} users`
        );
      }
    }

    console.log(
      `Seeding complete: ${allResults.length} users, ${allResults.length * ENDPOINTS_PER_USER} endpoints`
    );

    return {
      userCount: allResults.length,
      endpointCount: allResults.length * ENDPOINTS_PER_USER,
      requestLimitPerUser: REQUEST_LIMIT_PER_USER,
      users: allResults,
    };
  },
});

/**
 * Read-only query to list existing test data without mutations.
 * Used by --skip-seed and cleanup to discover test users/endpoints.
 */
export const listTestDataBatch = internalQuery({
  args: {
    batchIndex: v.number(),
    batchSize: v.number(),
  },
  handler: async (ctx, { batchIndex, batchSize }) => {
    const startIdx = batchIndex * batchSize;
    const endIdx = Math.min(startIdx + batchSize, TEST_USER_COUNT);
    const results: Array<{
      userId: string;
      email: string;
      slugs: string[];
      endpointIds: string[];
    }> = [];

    for (let i = startIdx; i < endIdx; i++) {
      const email = `${TEST_EMAIL_PREFIX}${i}${TEST_EMAIL_DOMAIN}`;
      const user = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (!user) continue;

      const endpoints = await ctx.db
        .query("endpoints")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .take(ENDPOINTS_PER_USER + 1);

      results.push({
        userId: user._id,
        email,
        slugs: endpoints.map((ep) => ep.slug),
        endpointIds: endpoints.map((ep) => ep._id),
      });
    }

    return results;
  },
});

/**
 * Read-only action to list all existing test data.
 */
export const listTestData = internalAction({
  args: {},
  handler: async (ctx) => {
    const batchSize = 25;
    const batches = Math.ceil(TEST_USER_COUNT / batchSize);
    const allResults: Array<{
      userId: string;
      email: string;
      slugs: string[];
      endpointIds: string[];
    }> = [];

    for (let i = 0; i < batches; i++) {
      const batch = await ctx.runQuery(internal.loadTest.listTestDataBatch, {
        batchIndex: i,
        batchSize,
      });
      allResults.push(...batch);
    }

    return {
      userCount: allResults.length,
      endpointCount: allResults.reduce((sum, u) => sum + u.slugs.length, 0),
      requestLimitPerUser: REQUEST_LIMIT_PER_USER,
      users: allResults,
    };
  },
});

/**
 * Count requests per endpoint for verification.
 * Called after load test to check how many requests were actually stored.
 */
export const verifyBatch = internalQuery({
  args: {
    slugs: v.array(v.string()),
  },
  handler: async (ctx, { slugs }) => {
    const results: Record<string, { endpointId: string; requestCount: number }> = {};

    for (const slug of slugs) {
      const endpoint = await ctx.db
        .query("endpoints")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();

      if (!endpoint) {
        results[slug] = { endpointId: "", requestCount: -1 };
        continue;
      }

      // Count requests (cap at 1000 to avoid timeout)
      const requests = await ctx.db
        .query("requests")
        .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
        .take(1001);

      results[slug] = {
        endpointId: endpoint._id,
        requestCount: requests.length,
      };
    }

    return results;
  },
});

/**
 * Get usage for test users to verify quota was tracked server-side.
 */
export const verifyUsage = internalQuery({
  args: {
    emails: v.array(v.string()),
  },
  handler: async (ctx, { emails }) => {
    const results: Record<string, { requestsUsed: number; requestLimit: number }> = {};

    for (const email of emails) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();

      if (user) {
        results[email] = {
          requestsUsed: user.requestsUsed,
          requestLimit: user.requestLimit,
        };
      }
    }

    return results;
  },
});

/**
 * Delete requests for a batch of endpoints (to avoid 10s timeout).
 */
export const cleanupRequestsBatch = internalMutation({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, { slug }) => {
    assertNotProduction();
    const endpoint = await ctx.db
      .query("endpoints")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!endpoint) return { deleted: 0 };

    // Stay well under the 4096 read limit per mutation
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_endpoint_time", (q) => q.eq("endpointId", endpoint._id))
      .take(200);

    for (const req of requests) {
      await ctx.db.delete(req._id);
    }
    return { deleted: requests.length };
  },
});

/**
 * Delete test endpoints for a batch of users.
 */
export const cleanupEndpointsBatch = internalMutation({
  args: {
    batchIndex: v.number(),
    batchSize: v.number(),
  },
  handler: async (ctx, { batchIndex, batchSize }) => {
    assertNotProduction();
    const startIdx = batchIndex * batchSize;
    const endIdx = Math.min(startIdx + batchSize, TEST_USER_COUNT);
    let deleted = 0;

    for (let i = startIdx; i < endIdx; i++) {
      const email = `${TEST_EMAIL_PREFIX}${i}${TEST_EMAIL_DOMAIN}`;
      const user = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      if (!user) continue;

      const endpoints = await ctx.db
        .query("endpoints")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .take(10);

      for (const ep of endpoints) {
        await ctx.db.delete(ep._id);
        deleted++;
      }

      await ctx.db.delete(user._id);
      deleted++;
    }

    return { deleted };
  },
});

/**
 * Full cleanup orchestrator.
 */
export const cleanup = internalAction({
  args: {},
  handler: async (ctx) => {
    assertNotProduction();
    const batchSize = 25;
    const batches = Math.ceil(TEST_USER_COUNT / batchSize);

    // Gather all slugs using read-only query (no mutations)
    console.log("Gathering slugs...");
    const allSlugs: string[] = [];
    for (let i = 0; i < batches; i++) {
      const batch = await ctx.runQuery(internal.loadTest.listTestDataBatch, {
        batchIndex: i,
        batchSize,
      });
      for (const u of batch) {
        allSlugs.push(...u.slugs);
      }
    }
    console.log(`Found ${allSlugs.length} slugs to clean up`);

    // Delete requests one slug at a time (stays under 4096 read limit)
    console.log("Cleaning up requests...");
    let totalRequestsDeleted = 0;
    for (let s = 0; s < allSlugs.length; s++) {
      // Multiple passes per slug in case there are more than 200 requests
      for (let pass = 0; pass < 20; pass++) {
        const result = await ctx.runMutation(internal.loadTest.cleanupRequestsBatch, {
          slug: allSlugs[s],
        });
        totalRequestsDeleted += result.deleted;
        if (result.deleted < 200) break; // fewer than limit = done
      }

      if ((s + 1) % 100 === 0) {
        console.log(
          `  Cleaned requests for ${s + 1}/${allSlugs.length} slugs (${totalRequestsDeleted} deleted)`
        );
      }
    }
    console.log(`Deleted ${totalRequestsDeleted} requests`);

    // Now delete endpoints and users
    console.log("Cleaning up endpoints and users...");
    let totalDeleted = 0;
    for (let i = 0; i < batches; i++) {
      const result = await ctx.runMutation(internal.loadTest.cleanupEndpointsBatch, {
        batchIndex: i,
        batchSize,
      });
      totalDeleted += result.deleted;
    }
    console.log(`Deleted ${totalDeleted} endpoints and users`);

    return { requestsDeleted: totalRequestsDeleted, entitiesDeleted: totalDeleted };
  },
});
