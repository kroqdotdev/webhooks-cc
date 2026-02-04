/**
 * Simple in-memory rate limiter for unauthenticated device auth endpoints.
 * Limits by IP address with a sliding window.
 *
 * NOTE: This rate limiter only works within a single process. In serverless or
 * multi-instance deployments, each instance maintains independent state.
 * See /docs/future/distributed-rate-limiting.md for a production-grade approach.
 */

const store = new Map<string, number[]>();

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Check if a request is rate-limited.
 * Performs lazy cleanup of expired entries on each call (no setInterval).
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
  const ip = getClientIp(request);
  const now = Date.now();

  // Lazy cleanup: remove expired entries periodically (every ~100 calls)
  if (Math.random() < 0.01) {
    for (const [key, timestamps] of store) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        store.delete(key);
      } else {
        store.set(key, valid);
      }
    }
  }

  const timestamps = store.get(ip) ?? [];
  const valid = timestamps.filter((t) => now - t < windowMs);

  if (valid.length >= maxRequests) {
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(windowMs / 1000)),
      },
    });
  }

  valid.push(now);
  store.set(ip, valid);
  return null;
}
