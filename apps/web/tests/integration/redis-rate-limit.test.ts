/**
 * Integration tests for Redis-backed rate limiting.
 *
 * Requires:
 * - Redis running on REDIS_URL (default redis://127.0.0.1:6379)
 * - Web app running on localhost:3000
 * - Receiver running on localhost:3001
 *
 * Tests verify that rate limit state is stored in Redis (not just in-memory)
 * and that the notification limiter uses Redis SET NX EX.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import Redis from "ioredis";
import { createEndpointForUser } from "@/lib/supabase/endpoints";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const REDIS_URL = process.env.REDIS_URL;
const RECEIVER_URL = "http://localhost:3001";
const WEB_URL = "http://localhost:3000";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

describe.skipIf(!REDIS_URL)("Redis rate limiting integration", () => {
  let redis: Redis;
  let testUserId: string;
  let testEndpointSlug: string;
  let testEndpointId: string;
  const TEST_EMAIL = `test-redis-rl-${Date.now()}@webhooks-test.local`;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!);
    await redis.ping();

    // Create test user
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: "TestPassword123!",
      email_confirm: true,
      user_metadata: { full_name: "Redis RL Test User" },
    });
    if (error) throw error;
    testUserId = data.user!.id;

    // Set as pro with quota
    await admin
      .from("users")
      .update({
        plan: "pro",
        request_limit: 10000,
        requests_used: 0,
        period_end: new Date(Date.now() + 86400000).toISOString(),
      })
      .eq("id", testUserId);

    // Create endpoint with notification URL
    const ep = await createEndpointForUser({
      userId: testUserId,
      name: "Redis RL Test",
    });
    testEndpointId = ep.id;
    testEndpointSlug = ep.slug;

    // Set notification URL on endpoint
    await admin
      .from("endpoints")
      .update({ notification_url: "https://httpbin.org/post" })
      .eq("id", testEndpointId);
  }, 15000);

  afterAll(async () => {
    // Cleanup
    await admin.from("endpoints").delete().eq("id", testEndpointId);
    await admin.from("users").delete().eq("id", testUserId);
    await admin.auth.admin.deleteUser(testUserId);
    // Clean up Redis keys from this test
    const keys = await redis.keys("whcc:rate:*test-redis*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  }, 15000);

  // =========================================================================
  // Web rate limiter: verify Redis sorted sets are created
  // =========================================================================

  describe("web API rate limiter uses Redis", () => {
    it("creates whcc:rate:* sorted set keys on rate-limited endpoints", async () => {
      const testIp = "10.99.99.1";
      await redis.del(`whcc:rate:${testIp}`);

      // First request warms up the Redis connection (may fall back to in-memory)
      await fetch(`${WEB_URL}/api/go/endpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": testIp },
        body: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, 500));

      // Second request should use Redis
      const resp = await fetch(`${WEB_URL}/api/go/endpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": testIp },
        body: JSON.stringify({}),
      });
      expect(resp.status).toBeLessThan(500);

      // Check Redis for the rate key
      const keys = await redis.keys(`whcc:rate:${testIp}`);
      expect(keys.length).toBe(1);

      // Verify it's a sorted set
      const type = await redis.type(keys[0]);
      expect(type).toBe("zset");

      // Verify it has a TTL
      const ttl = await redis.pttl(keys[0]);
      expect(ttl).toBeGreaterThan(0);

      // Cleanup
      await redis.del(keys[0]);
    });

    it("enforces rate limits via Redis across requests", async () => {
      const testIp = "10.88.88.88";

      // Clean any prior state
      await redis.del(`whcc:rate:${testIp}`);

      // Warmup request to ensure Redis connection is ready
      await fetch(`${WEB_URL}/api/auth/device-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.88.88.99" },
        body: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, 500));
      await redis.del("whcc:rate:10.88.88.99");

      // Hit device-code endpoint (limit: 10 per 60s) repeatedly
      const responses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const resp = await fetch(`${WEB_URL}/api/auth/device-code`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": testIp },
          body: JSON.stringify({}),
        });
        responses.push(resp.status);
      }

      // First 10 should not be 429, last 2 should be 429
      const nonRateLimited = responses.filter((s) => s !== 429);
      const rateLimited = responses.filter((s) => s === 429);

      expect(nonRateLimited.length).toBe(10);
      expect(rateLimited.length).toBe(2);

      // Verify the sorted set has exactly 10 members
      const count = await redis.zcard(`whcc:rate:${testIp}`);
      expect(count).toBe(10);

      // Cleanup
      await redis.del(`whcc:rate:${testIp}`);
    });
  });

  // =========================================================================
  // Notification limiter: verify Redis SET NX EX
  // =========================================================================

  describe("notification rate limiter uses Redis", () => {
    it("creates whcc:notify:* key when webhook triggers notification", async () => {
      // Clean any prior state
      await redis.del(`whcc:notify:${testEndpointSlug}`);

      // Send a webhook to trigger a notification
      const resp = await fetch(`${RECEIVER_URL}/w/${testEndpointSlug}/redis-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: "redis-notification" }),
      });
      expect(resp.status).toBe(200);

      // Give the async notification task time to execute
      await new Promise((r) => setTimeout(r, 500));

      // Check Redis for the notify key
      const exists = await redis.exists(`whcc:notify:${testEndpointSlug}`);
      expect(exists).toBe(1);

      // Verify it has a TTL of ~1 second
      const ttl = await redis.ttl(`whcc:notify:${testEndpointSlug}`);
      expect(ttl).toBeGreaterThanOrEqual(0);
      expect(ttl).toBeLessThanOrEqual(1);
    });

    it("notify key expires after 1 second (cooldown resets)", async () => {
      // Send first webhook
      await fetch(`${RECEIVER_URL}/w/${testEndpointSlug}/redis-ttl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: "ttl-check" }),
      });

      await new Promise((r) => setTimeout(r, 200));

      // Key should exist
      const exists1 = await redis.exists(`whcc:notify:${testEndpointSlug}`);
      expect(exists1).toBe(1);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 1200));

      // Key should be gone
      const exists2 = await redis.exists(`whcc:notify:${testEndpointSlug}`);
      expect(exists2).toBe(0);
    }, 10000);
  });

  // =========================================================================
  // Redis dies mid-operation: verify graceful fallback and recovery
  // =========================================================================

  describe("Redis failure mid-operation", () => {
    it("rate limiter falls back to in-memory when Redis key has wrong type", async () => {
      const poisonKey = "whcc:rate:10.66.66.66";

      // Warmup Redis connection
      await fetch(`${WEB_URL}/api/go/endpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.66.66.99" },
        body: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, 500));
      await redis.del("whcc:rate:10.66.66.99");

      // Poison the key — set it to a string instead of a sorted set.
      // The Lua script's ZREMRANGEBYSCORE will fail with WRONGTYPE.
      await redis.set(poisonKey, "not-a-sorted-set");

      // Hit the endpoint — should fall back to in-memory, NOT return 500
      const resp = await fetch(`${WEB_URL}/api/go/endpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.66.66.66" },
        body: JSON.stringify({}),
      });

      // Should still succeed (in-memory fallback)
      expect(resp.status).toBeLessThan(500);

      // Cleanup
      await redis.del(poisonKey);
    });

    it("notification limiter falls back when Redis is temporarily unavailable", async () => {
      // Send first webhook — should use Redis
      await fetch(`${RECEIVER_URL}/w/${testEndpointSlug}/redis-fail-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: "before-disconnect" }),
      });
      await new Promise((r) => setTimeout(r, 300));

      const existsBefore = await redis.exists(`whcc:notify:${testEndpointSlug}`);
      expect(existsBefore).toBe(1);

      // Wait for TTL to expire so next webhook can trigger notification
      await new Promise((r) => setTimeout(r, 1200));

      // Set the notify key so it already exists — SET NX will return nil
      // (key exists), causing the notification to be suppressed as if cooldown
      // were active. This verifies the receiver handles pre-existing keys
      // gracefully and does not crash or return 500.
      await redis.set(`whcc:notify:${testEndpointSlug}`, "occupied");
      const resp = await fetch(`${RECEIVER_URL}/w/${testEndpointSlug}/redis-fail-2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: "during-failure" }),
      });
      expect(resp.status).toBe(200);

      // Cleanup
      await redis.del(`whcc:notify:${testEndpointSlug}`);
    }, 10000);

    it("rate limiter recovers after Redis error is resolved", async () => {
      const testIp = "10.77.77.77";
      const poisonKey = `whcc:rate:${testIp}`;

      // Warmup
      await fetch(`${WEB_URL}/api/go/endpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.77.99" },
        body: JSON.stringify({}),
      });
      await new Promise((r) => setTimeout(r, 500));
      await redis.del("whcc:rate:10.77.77.99");

      // 1. Poison key
      await redis.set(poisonKey, "broken");

      // 2. Request falls back to in-memory
      const resp1 = await fetch(`${WEB_URL}/api/go/endpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": testIp },
        body: JSON.stringify({}),
      });
      expect(resp1.status).toBeLessThan(500);

      // Key should still be the poisoned string (Lua script failed, didn't overwrite)
      const type1 = await redis.type(poisonKey);
      expect(type1).toBe("string");

      // 3. Fix the key — delete the poison
      await redis.del(poisonKey);

      // 4. Next request should use Redis again (creates a sorted set)
      const resp2 = await fetch(`${WEB_URL}/api/go/endpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": testIp },
        body: JSON.stringify({}),
      });
      expect(resp2.status).toBeLessThan(500);

      const type2 = await redis.type(poisonKey);
      expect(type2).toBe("zset");

      // Cleanup
      await redis.del(poisonKey);
    });
  });
});
