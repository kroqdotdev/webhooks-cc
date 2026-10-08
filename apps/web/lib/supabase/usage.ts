import { createAdminClient } from "./admin";
import type { UserPlan } from "./api-keys";

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
}

export async function getUsageForUser(userId: string): Promise<UsageInfo | null> {
  const admin = createAdminClient();
  const { data: user, error } = await admin
    .from("users")
    .select("plan, requests_used, request_limit, period_start, period_end")
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
  const emails =
    used > 0 && user.period_start ? await countPeriodEmails(userId, user.period_start) : 0;

  return {
    used,
    limit: user.request_limit,
    remaining: Math.max(0, user.request_limit - used),
    plan: user.plan,
    periodEnd: periodActive ? periodEndMs : null,
    teamBilledEndpoints: teamBilledEndpoints ?? 0,
    emails: Math.min(emails, used),
  };
}

/**
 * Emails billed to the user since the period began, from the daily rollup
 * (request rows may already be gone to retention). Team-billed endpoints
 * count against the team's pool, so their rows are left out.
 */
async function countPeriodEmails(userId: string, periodStart: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoint_daily_stats")
    .select("emails")
    .eq("user_id", userId)
    .is("team_id", null)
    .gte("day", periodStart.slice(0, 10));
  if (error) throw error;
  return (data ?? []).reduce((total, row) => total + Number(row.emails ?? 0), 0);
}
