/**
 * Timing for the post-checkout wait.
 *
 * Polar redirects the owner back to the team page before the
 * `subscription.created` webhook has necessarily landed, so the page polls its
 * own team row until `subscription_status` turns non-null. Pure timing lives
 * here so the schedule is testable without a component harness.
 */

export const ACTIVATION_POLL_INTERVAL_MS = 3_000;
export const ACTIVATION_TIMEOUT_MS = 60_000;

/** Upper bound on poll attempts implied by the interval and the timeout. */
export const ACTIVATION_MAX_POLLS = Math.floor(ACTIVATION_TIMEOUT_MS / ACTIVATION_POLL_INTERVAL_MS);

/** True once the activation window has elapsed and polling should stop. */
export function hasActivationTimedOut(startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs >= ACTIVATION_TIMEOUT_MS;
}
