/**
 * Rate limiter configuration for webhooks.cc.
 *
 * Uses token bucket algorithm for ephemeral endpoint rate limiting:
 * - 50 tokens per endpoint lifetime (period = EPHEMERAL_TTL_MS)
 * - Users can burst 50 requests at once, or spread them over the endpoint lifetime
 */
import { RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import { EPHEMERAL_TTL_MS } from "./config";

// Rate limit for ephemeral/demo endpoints: 50 requests per endpoint lifetime
export const EPHEMERAL_RATE_LIMIT = 50;

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Token bucket for ephemeral endpoints
  // Key: endpoint slug
  // Capacity: 50 tokens (requests)
  // Refill: full bucket every EPHEMERAL_TTL_MS (matches endpoint lifetime)
  ephemeralEndpoint: {
    kind: "token bucket",
    rate: EPHEMERAL_RATE_LIMIT,
    period: EPHEMERAL_TTL_MS,
    capacity: EPHEMERAL_RATE_LIMIT,
  },
  // Endpoint creation rate limits (abuse protection)
  // Per-user: keyed by userId
  endpointCreationUser: {
    kind: "token bucket",
    rate: 10,
    period: 10 * 60 * 1000, // 10 minutes
    capacity: 10,
  },
  // Anonymous: keyed by "global" (Convex mutations have no IP access).
  // Higher capacity than per-user because this single bucket is shared
  // across all anonymous users.
  endpointCreationAnon: {
    kind: "token bucket",
    rate: 20,
    period: 10 * 60 * 1000, // 10 minutes
    capacity: 20,
  },
});
