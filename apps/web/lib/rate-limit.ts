/**
 * Simple in-memory rate limiter for unauthenticated device auth endpoints.
 * Limits by IP address with a sliding window.
 *
 * NOTE: This rate limiter only works within a single process. In serverless or
 * multi-instance deployments, each instance maintains independent state.
 * See /docs/future/distributed-rate-limiting.md for a production-grade approach.
 */

const store = new Map<string, number[]>();

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

/**
 * Check if a request is rate-limited, returning full metadata.
 * @param request - The incoming request (IP extracted from headers)
 * @param maxRequests - Max requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns RateLimitInfo with allowed status, response, and metadata
 */
export function checkRateLimitWithInfo(
  request: Request,
  maxRequests: number,
  windowMs: number = 60_000
): RateLimitInfo {
  const ip = getClientIp(request);
  return checkRateLimitByKeyWithInfo(ip, maxRequests, windowMs);
}

/**
 * Check if a key is rate-limited, returning full metadata.
 * Performs lazy cleanup of expired entries on each call (no setInterval).
 * @param key - The rate limit key (e.g. IP address, user ID)
 * @param maxRequests - Max requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns RateLimitInfo with allowed status, response, and metadata
 */
export function checkRateLimitByKeyWithInfo(
  key: string,
  maxRequests: number,
  windowMs: number = 60_000
): RateLimitInfo {
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
    const info: RateLimitInfo = {
      allowed: false,
      response: null, // set below
      limit: maxRequests,
      remaining,
      reset,
    };

    const response = new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(windowMs / 1000)),
        "X-RateLimit-Limit": String(maxRequests),
        "X-RateLimit-Remaining": String(remaining),
        "X-RateLimit-Reset": String(reset),
      },
    });

    info.response = response;
    return info;
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
 * Check if a request is rate-limited.
 * @param request - The incoming request
 * @param maxRequests - Max requests allowed in the window
 * @param windowMs - Window size in milliseconds
 * @returns Response if rate-limited, null if allowed
 */
export function checkRateLimit(
  request: Request,
  maxRequests: number,
  windowMs: number = 60_000
): Response | null {
  return checkRateLimitWithInfo(request, maxRequests, windowMs).response;
}

export function checkRateLimitByKey(
  key: string,
  maxRequests: number,
  windowMs: number = 60_000
): Response | null {
  return checkRateLimitByKeyWithInfo(key, maxRequests, windowMs).response;
}
