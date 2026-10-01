import type { AccountProfile } from "@/lib/account-profile";

type QuotaFields = Pick<AccountProfile, "requests_used" | "request_limit" | "period_end">;

/**
 * True while the receiver is rejecting this user's webhooks with 429: the
 * current period's quota is used up and the period has not reset yet. Once
 * `period_end` passes, the next capture starts a fresh period, so an expired
 * period never counts as exhausted.
 */
export function isQuotaExhausted(profile: QuotaFields | null, nowMs: number): boolean {
  if (!profile || profile.request_limit <= 0 || !profile.period_end) return false;
  if (new Date(profile.period_end).getTime() <= nowMs) return false;
  return profile.requests_used >= profile.request_limit;
}
