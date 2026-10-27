import type { AccountProfile } from "@/lib/account-profile";
import { isCapacityExhausted, type CapacityFields } from "@/lib/capacity";

type QuotaFields = Pick<AccountProfile, "requests_used" | "request_limit" | "period_end"> &
  Partial<Omit<CapacityFields, "requests_used" | "request_limit" | "period_end">>;

/**
 * True while the receiver is rejecting this user's webhooks with 429: the
 * current period's allowance (plan plus recurring blocks) is used up, no
 * one-time blocks are left, overage is off or at its maximum, and the period
 * has not reset yet. Once `period_end` passes, the next capture starts a
 * fresh period, so an expired period never counts as exhausted.
 */
export function isQuotaExhausted(profile: QuotaFields | null, nowMs: number): boolean {
  if (!profile) return false;
  return isCapacityExhausted(
    {
      block_requests: 0,
      credit_requests: 0,
      overage_active: false,
      overage_max: 0,
      overage_used: 0,
      overage_period_start: null,
      period_start: null,
      ...profile,
    },
    nowMs
  );
}
