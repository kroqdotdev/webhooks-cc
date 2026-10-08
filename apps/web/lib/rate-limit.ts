/**
 * Distributed rate limiter with Redis backend and in-memory fallback.
 *
 * When REDIS_URL is set, uses Redis sorted sets for a sliding window that
 * works across multiple instances. Falls back to in-memory when Redis is
 * unavailable or unset (development mode).
 */

import { isIPv4, isIPv6 } from "node:net";
import { getRedisClient, isRedisAvailable } from "./redis";

/** In-memory fallback: request times per bucket, with the window each bucket was checked with. */
const store = new Map<string, { windowMs: number; timestamps: number[] }>();
let lastFallbackWarnAt = 0;

/** Metadata returned by the WithInfo rate limit variants. */
export interface RateLimitInfo {
  /** Whether the request is allowed (true) or rate-limited (false). */
  allowed: boolean;
  /** A 429 Response when rate-limited, or null when allowed. */
  response: Response | null;
  /** The maximum number of requests allowed in the window. */
  limit: number;
  /** How many requests remain in the current window. */
  remaining: number;
  /** Unix epoch seconds when the current window resets. */
  reset: number;
}

/**
 * Set standard rate limit headers on a response.
 * Returns the same response object for chaining convenience.
 */
export function applyRateLimitHeaders(response: Response, info: RateLimitInfo): Response {
  response.headers.set("X-RateLimit-Limit", String(info.limit));
  response.headers.set("X-RateLimit-Remaining", String(info.remaining));
  response.headers.set("X-RateLimit-Reset", String(info.reset));
  return response;
}

/**
 * Best-effort client IP for rate-limit keying and audit headers.
 *
 * Production traffic arrives via Cloudflare, which sets `CF-Connecting-IP` to
 * the real client and only *appends* to any `X-Forwarded-For` the client sent.
 * Keying on the first XFF hop therefore let an attacker pick a fresh bucket per
 * request by sending their own `X-Forwarded-For`. Prefer `CF-Connecting-IP`,
 * then the first XFF hop (dev/direct traffic), then `X-Real-IP`.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

/**
 * The part of a client IP that a rate limit counts: IPv4 addresses as they
 * are, IPv6 addresses by their /64, because one IPv6 client usually holds a
 * whole /64 and could otherwise use a fresh address per request.
 * IPv4-mapped IPv6 addresses count as their IPv4 address.
 */
export function rateLimitIpBucket(ip: string): string {
  const address = ip.split("%")[0].toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}(?::|0{0,4}:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(address)) return address;
  const [head, tail] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array(8 - headGroups.length - tailGroups.length).fill("0"),
          ...tailGroups,
        ];
  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, "0"))
    .join(":")}::/64`;
}

/**
 * The storage key of a limit. The window is part of it, so two limits that
 * happen to share a key never trim each other's history: each check trims
 * its bucket to its own window.
 */
function bucketKey(key: string, windowMs: number): string {
  return `${key}:${windowMs}`;
}

// Lua script for atomic sliding window rate limiting via sorted set.
// Returns [count_before_add, earliest_score].
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local earliest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if count < max then
  redis.call('ZADD', key, now, member)
end
redis.call('PEXPIRE', key, window + 1000)
local score = 0
if earliest[2] then score = tonumber(earliest[2]) else score = now end
return {count, score}
`;

/**
 * Try Redis-backed sliding window. Returns RateLimitInfo on success, null on failure.
 */
async function tryRedisRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitInfo | null> {
  if (!isRedisAvailable()) return null;
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
    // ioredis .eval() executes a Redis EVAL command (Lua script), not JS eval.
    // 100ms timeout — if Redis doesn't respond on localhost, fall back fast.
    const evalPromise = redis["eval"](
      SLIDING_WINDOW_SCRIPT,
      1,
      `whcc:rate:${bucketKey(key, windowMs)}`,
      String(windowMs),
      String(maxRequests),
      String(now),
      member
    );
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Redis eval timeout")), 100)
    );
    const result = (await Promise.race([evalPromise, timeoutPromise])) as [number, number];

    const count = result[0];
    const earliest = result[1];
    const reset = Math.ceil((earliest + windowMs) / 1000);

    if (count >= maxRequests) {
      const remaining = 0;
      const retryAfter = Math.max(1, reset - Math.floor(now / 1000));
      return {
        allowed: false,
        response: new Response(JSON.stringify({ error: "Too many requests" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(maxRequests),
            "X-RateLimit-Remaining": String(remaining),
            "X-RateLimit-Reset": String(reset),
          },
        }),
        limit: maxRequests,
        remaining,
        reset,
      };
    }

    return {
      allowed: true,
      response: null,
      limit: maxRequests,
      remaining: maxRequests - count - 1,
      reset,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(`[rate-limit] Redis eval failed: ${err}`);
    console.error("[rate-limit] Redis eval failed:", error.message);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sendError } = require("@appsignal/nodejs");
      sendError(error);
    } catch {
      // AppSignal not available
    }
    return null;
  }
}

/**
 * In-memory sliding window fallback, used when Redis is unset or down.
 */
function inMemoryRateLimit(key: string, maxRequests: number, windowMs: number): RateLimitInfo {
  const now = Date.now();
  const storeKey = bucketKey(key, windowMs);

  // Lazy cleanup (every ~100 calls), each bucket by its own window.
  if (Math.random() < 0.01) {
    for (const [k, bucket] of store) {
      const valid = bucket.timestamps.filter((t) => now - t < bucket.windowMs);
      if (valid.length === 0) {
        store.delete(k);
      } else {
        store.set(k, { windowMs: bucket.windowMs, timestamps: valid });
      }
    }
  }

  const timestamps = store.get(storeKey)?.timestamps ?? [];
  const valid = timestamps.filter((t) => now - t < windowMs);

  // Calculate reset: earliest timestamp in window + windowMs, as Unix seconds
  const earliest = valid.length > 0 ? valid[0] : now;
  const reset = Math.ceil((earliest + windowMs) / 1000);

  if (valid.length >= maxRequests) {
    const remaining = 0;
    const retryAfter = Math.max(1, reset - Math.floor(now / 1000));
    return {
      allowed: false,
      response: new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(maxRequests),
          "X-RateLimit-Remaining": String(remaining),
          "X-RateLimit-Reset": String(reset),
        },
      }),
      limit: maxRequests,
      remaining,
      reset,
    };
  }

  valid.push(now);
  store.set(storeKey, { windowMs, timestamps: valid });

  return {
    allowed: true,
    response: null,
    limit: maxRequests,
    remaining: maxRequests - valid.length,
    reset,
  };
}

/**
 * Check if a request is rate-limited by its client IP, returning full metadata.
 * @param request - The incoming request (IP extracted from headers)
 * @param scope - Names the limit (usually the route), so each limit counts on its own
 * @param maxRequests - Max requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns RateLimitInfo with allowed status, response, and metadata
 */
export async function checkRateLimitWithInfo(
  request: Request,
  scope: string,
  maxRequests: number,
  windowMs: number = 60_000
): Promise<RateLimitInfo> {
  const bucket = rateLimitIpBucket(getClientIp(request));
  return checkRateLimitByKeyWithInfo(`ip:${scope}:${bucket}`, maxRequests, windowMs);
}

/**
 * Check if a key is rate-limited, returning full metadata.
 * Uses Redis when available, falls back to in-memory.
 * @param key - The rate limit key (e.g. IP address, user ID)
 * @param maxRequests - Max requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns RateLimitInfo with allowed status, response, and metadata
 */
export async function checkRateLimitByKeyWithInfo(
  key: string,
  maxRequests: number,
  windowMs: number = 60_000
): Promise<RateLimitInfo> {
  const redisResult = await tryRedisRateLimit(key, maxRequests, windowMs);
  if (redisResult) return redisResult;
  if (getRedisClient()) {
    const now = Date.now();
    if (now - lastFallbackWarnAt > 30_000) {
      lastFallbackWarnAt = now;
      console.warn("[rate-limit] Redis unavailable, falling back to in-memory");
    }
  }
  return inMemoryRateLimit(key, maxRequests, windowMs);
}

/**
 * Check if a request is rate-limited by its client IP.
 * @param request - The incoming request
 * @param scope - Names the limit (usually the route), so each limit counts on its own
 * @param maxRequests - Max requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns Response if rate-limited, null if allowed
 */
export async function checkRateLimit(
  request: Request,
  scope: string,
  maxRequests: number,
  windowMs: number = 60_000
): Promise<Response | null> {
  return (await checkRateLimitWithInfo(request, scope, maxRequests, windowMs)).response;
}

export async function checkRateLimitByKey(
  key: string,
  maxRequests: number,
  windowMs: number = 60_000
): Promise<Response | null> {
  return (await checkRateLimitByKeyWithInfo(key, maxRequests, windowMs)).response;
}
