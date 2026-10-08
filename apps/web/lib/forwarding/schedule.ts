/**
 * When a forwarded email is tried again. A delivery that fails (no 2xx, a
 * timeout or no connection) is retried after each of these delays, about a
 * day in total, and then marked failed. Documented at /docs/forwarding.
 */
export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 10_800, 21_600, 43_200] as const;

/** The first try plus one per delay. */
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/** Seconds until the next try after try number `attempt` (1-based) failed; null after the last. */
export function retryDelaySeconds(attempt: number): number | null {
  return Number.isInteger(attempt) && attempt >= 1 && attempt <= RETRY_DELAYS_SECONDS.length
    ? RETRY_DELAYS_SECONDS[attempt - 1]
    : null;
}
