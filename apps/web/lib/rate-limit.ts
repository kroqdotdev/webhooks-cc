/**
 * Distributed rate limiter with Redis backend and in-memory fallback.
 *
 * When REDIS_URL is set, uses Redis sorted sets for a sliding window that
 * works across multiple instances. Falls back to in-memory when Redis is
 * unavailable or unset (development mode).
 */

import { getRedisClient, isRedisAvailable } from "./redis";

const store = new Map<string, number[]>();
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

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
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
    // ioredis .eval() executes a Redis EVAL command (Lua script), not JS eval
    const result = (await redis["eval"](
      SLIDING_WINDOW_SCRIPT,
      1,
      `whcc:rate:${key}`,
      String(windowMs),
      String(maxRequests),
      String(now),
      member
    )) as [number, number];

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
    console.error("[rate-limit] Redis eval failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * In-memory sliding window fallback (unchanged from original implementation).
 */
function inMemoryRateLimit(key: string, maxRequests: number, windowMs: number): RateLimitInfo {
  const now = Date.now();

  // Lazy cleanup: remove expired entries periodically (every ~100 calls)
  if (Math.random() < 0.01) {
    for (const [k, timestamps] of store) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        store.delete(k);
      } else {
        store.set(k, valid);
      }
    }
  }

  const timestamps = store.get(key) ?? [];
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
  store.set(key, valid);

  return {
    allowed: true,
    response: null,
    limit: maxRequests,
    remaining: maxRequests - valid.length,
    reset,
  };
}

/**
 * Check if a request is rate-limited, returning full metadata.
 * @param request - The incoming request (IP extracted from headers)
 * @param maxRequests - Max requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns RateLimitInfo with allowed status, response, and metadata
 */
export async function checkRateLimitWithInfo(
  request: Request,
  maxRequests: number,
  windowMs: number = 60_000
): Promise<RateLimitInfo> {
  const ip = getClientIp(request);
  return checkRateLimitByKeyWithInfo(ip, maxRequests, windowMs);
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
 * Check if a request is rate-limited.
 * @param request - The incoming request
 * @param maxRequests - Max requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns Response if rate-limited, null if allowed
 */
export async function checkRateLimit(
  request: Request,
  maxRequests: number,
  windowMs: number = 60_000
): Promise<Response | null> {
  return (await checkRateLimitWithInfo(request, maxRequests, windowMs)).response;
}

export async function checkRateLimitByKey(
  key: string,
  maxRequests: number,
  windowMs: number = 60_000
): Promise<Response | null> {
  return (await checkRateLimitByKeyWithInfo(key, maxRequests, windowMs)).response;
}
