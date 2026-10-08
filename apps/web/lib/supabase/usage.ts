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
 * Emails billed to the user since the period began. Team-billed endpoints
 * count against the team's pool, so their rows are left out.
 *
 * Whole days after the period's first day come from the daily rollup, which
 * outlives deleted requests. The first day is counted from the request rows,
 * because a period can start partway through a day and the rollup cannot say
 * which of that day's emails belong to the previous period. An email deleted
 * on that first day is missed, which only moves it to the HTTP side of a
 * display-only split.
 *
 * A lazy Free period starts at its first capture, with `period_start` from
 * the database clock and that capture's `received_at` from the receiver (or
 * the MX host) a moment earlier, so the first-day count starts
 * PERIOD_START_SLACK_MS before `period_start`.
 */
const PERIOD_START_SLACK_MS = 5 * 60_000;

async function countPeriodEmails(userId: string, periodStart: string): Promise<number> {
  const start = new Date(periodStart);
  if (!Number.isFinite(start.getTime())) return 0;
  const countFrom = new Date(start.getTime() - PERIOD_START_SLACK_MS);
  const startDay = start.toISOString().slice(0, 10);
  const nextDay = new Date(`${startDay}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);

  const admin = createAdminClient();
  const [laterDays, firstDay] = await Promise.all([
    admin
      .from("endpoint_daily_stats")
      .select("emails")
      .eq("user_id", userId)
      .is("team_id", null)
      .gt("day", startDay),
    admin
      .from("requests")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("kind", "email")
      .is("team_id", null)
      .gte("received_at", countFrom.toISOString())
      .lt("received_at", nextDay.toISOString()),
  ]);
  if (laterDays.error) throw laterDays.error;
  if (firstDay.error) throw firstDay.error;
  const later = (laterDays.data ?? []).reduce((total, row) => total + Number(row.emails ?? 0), 0);
  return later + (firstDay.count ?? 0);
}
