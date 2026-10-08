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
    used > 0 && user.period_start
      ? await countPeriodEmails(userId, user.period_start, user.plan === "free")
      : 0;

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
 * Emails billed to the user since the period began, counted from the request
 * rows through the partial index requests_user_email_time (migration 00049).
 * The rows outlive a period (Free keeps 7 days for a 24-hour period, Pro 31
 * for 30); an email the user deleted is missed, which only moves it to the
 * HTTP side of a display-only split. Team-billed rows count against the
 * team's pool, so they are left out.
 *
 * A lazy Free period starts at its first capture, with `period_start` from
 * the database clock and that capture's `received_at` from the receiver (or
 * the MX host) a moment earlier, so a Free count starts PERIOD_START_SLACK_MS
 * before `period_start`. A Pro period starts at renewal, not at a capture,
 * so its count starts exactly there.
 */
const PERIOD_START_SLACK_MS = 5 * 60_000;

async function countPeriodEmails(
  userId: string,
  periodStart: string,
  lazyPeriod: boolean
): Promise<number> {
  const start = Date.parse(periodStart);
  if (!Number.isFinite(start)) return 0;
  const from = lazyPeriod ? start - PERIOD_START_SLACK_MS : start;
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", "email")
    .is("team_id", null)
    .gte("received_at", new Date(from).toISOString());
  if (error) throw error;
  return count ?? 0;
}
