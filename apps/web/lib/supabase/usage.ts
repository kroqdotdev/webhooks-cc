import { createAdminClient } from "./admin";
import type { UserPlan } from "./api-keys";
import { getQuotaRejections, NO_QUOTA_REJECTIONS, type QuotaRejections } from "./quota-rejections";

export interface UsageInfo {
  used: number;
  limit: number;
  remaining: number;
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
      "plan, requests_used, request_limit, period_start, period_end, emails_used, emails_period_start"
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

  const exhausted = periodActive && user.request_limit > 0 && used >= user.request_limit;
  const quotaRejections = exhausted ? await getQuotaRejections(userId) : NO_QUOTA_REJECTIONS;

  return {
    used,
    limit: user.request_limit,
    remaining: Math.max(0, user.request_limit - used),
    plan: user.plan,
    periodEnd: periodActive ? periodEndMs : null,
    teamBilledEndpoints: teamBilledEndpoints ?? 0,
    emails: Math.min(emails, used),
    quotaRejections,
  };
}
