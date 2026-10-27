import { isCapacityExhausted, periodOverageUsed, remainingCapacity } from "@/lib/capacity";
import { createAdminClient } from "./admin";
import type { UserPlan } from "./api-keys";
import { reportError } from "@/lib/observability";
import { getQuotaRejections, NO_QUOTA_REJECTIONS, type QuotaRejections } from "./quota-rejections";

export interface UsageInfo {
  /** Requests used of the period's allowance. */
  used: number;
  /** The period's allowance: the plan's requests plus monthly blocks. */
  limit: number;
  /**
   * Requests still accepted this period: what is left of the allowance, plus
   * one-time blocks, plus overage up to its maximum.
   */
  remaining: number;
  /** Requests monthly blocks add to `limit` this period. */
  blockRequests: number;
  /** One-time blocks left, in requests; used once the allowance is gone. */
  creditRequests: number;
  /** Metered overage: counted this period, up to `max`, while `active`. */
  overage: { active: boolean; used: number; max: number };
  plan: UserPlan;
  periodEnd: number | null;
  /**
   * Owned endpoints shared with a subscribed team. capture_webhook() bills
   * those to the team, so they keep capturing when this quota is used up.
   */
  teamBilledEndpoints: number;
  /** How many of `used` were emails (owner-billed, current period). */
  emails: number;
  /**
   * Webhooks rejected with 429 this period on the user's own endpoints, by
   * endpoint. Only read while the quota is exhausted; empty otherwise.
   */
  quotaRejections: QuotaRejections;
}

export async function getUsageForUser(userId: string): Promise<UsageInfo | null> {
  const admin = createAdminClient();
  const { data: user, error } = await admin
    .from("users")
    .select(
      "plan, requests_used, request_limit, period_start, period_end, emails_used, emails_period_start, block_requests, credit_requests, overage_active, overage_max, overage_used, overage_period_start"
    )
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!user || (user.plan !== "free" && user.plan !== "pro")) {
    return null;
  }

  const { data: teamBilledEndpoints, error: countError } = await admin.rpc(
    "count_team_billed_endpoints",
    { p_user_id: userId }
  );
  if (countError) {
    throw countError;
  }

  const now = Date.now();
  const periodEndMs = user.period_end ? Date.parse(user.period_end) : NaN;
  const periodActive = Number.isFinite(periodEndMs) && periodEndMs > now;
  const used = user.plan === "free" && !periodActive ? 0 : user.requests_used;
  // capture_webhook() counts emails with the period_start they belong to
  // (migration 00049), so a count from an earlier period reads as none.
  const emails =
    user.period_start && user.emails_period_start === user.period_start ? user.emails_used : 0;

  const capacity = { ...user, requests_used: used };
  const exhausted = isCapacityExhausted(capacity, now);
  // The counts are extra detail: if they cannot be read (e.g. migration 00060
  // not applied yet), usage still returns rather than failing for the users
  // who most need it.
  let quotaRejections = NO_QUOTA_REJECTIONS;
  if (exhausted) {
    try {
      quotaRejections = await getQuotaRejections(userId);
    } catch (rejectionsError) {
      reportError("[usage] quota rejection counts failed", rejectionsError);
    }
  }

  return {
    used,
    limit: user.request_limit + user.block_requests,
    remaining: remainingCapacity(capacity),
    blockRequests: user.block_requests,
    creditRequests: user.credit_requests,
    overage: {
      active: user.overage_active,
      used: periodOverageUsed(user),
      max: user.overage_max,
    },
    plan: user.plan,
    periodEnd: periodActive ? periodEndMs : null,
    teamBilledEndpoints: teamBilledEndpoints ?? 0,
    emails: Math.min(emails, used),
    quotaRejections,
  };
}
