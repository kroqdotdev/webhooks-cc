import {
  type ServerEvent,
  captureServerEvent,
  flushServerAnalytics,
  flushServerAnalyticsOrThrow,
  serverAnalyticsEnabled,
  stableEventUuid,
} from "@/lib/analytics-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";

/**
 * Server-side analytics reports (migration 00080): the accounts created in
 * each hour (`account_signed_up`) and, for each UTC day, a usage snapshot per
 * account (`usage_daily`, plus `first_request_captured` on an account's first
 * day with captures, and `api_reads_daily` for each client it read through,
 * from lib/analytics-reads.ts) that also brings its person properties up to
 * date. Webhook traffic and API calls reach PostHog only as these daily counts.
 *
 * Each period is claimed in analytics_report_runs before it is sent, so
 * several processes never send it twice, and released again when reading it
 * fails; periods missed while the app was down are caught up within the
 * lookback. Events carry stable ids and their period's timestamp, so a resend
 * is dropped by PostHog.
 */

const TICK_MS = 5 * 60_000;
const FIRST_TICK_MS = 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** How long after a period ends before it is reported, so late writes land. */
const SETTLE_MS = 10 * 60_000;
const SIGNUP_LOOKBACK_HOURS = 48;
const DAILY_LOOKBACK_DAYS = 3;
/** Rows per page: below PostgREST's row cap, and a page's events fit posthog-node's queue. */
const PAGE_SIZE = 500;

type Report = "signups" | "daily_usage";

/** The finished periods in the lookback, oldest first. */
export function duePeriods(now: Date, report: Report): Date[] {
  const size = report === "signups" ? HOUR_MS : DAY_MS;
  const count = report === "signups" ? SIGNUP_LOOKBACK_HOURS : DAILY_LOOKBACK_DAYS;
  const lastStart = Math.floor((now.getTime() - SETTLE_MS) / size) * size - size;
  const periods: Date[] = [];
  for (let i = count - 1; i >= 0; i--) periods.push(new Date(lastStart - i * size));
  return periods;
}

async function claimedPeriods(report: Report, since: Date): Promise<Set<number>> {
  const { data, error } = await createAdminClient()
    .from("analytics_report_runs")
    .select("period_start")
    .eq("report", report)
    .gte("period_start", since.toISOString());
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((row) => Date.parse(row.period_start)));
}

/** True when this process claimed the period; false when another one has it. */
async function claim(report: Report, periodStart: Date): Promise<boolean> {
  const { error } = await createAdminClient()
    .from("analytics_report_runs")
    .insert({ report, period_start: periodStart.toISOString() });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(error.message);
}

async function sendSignups(hourStart: Date): Promise<number> {
  const hourEnd = new Date(hourStart.getTime() + HOUR_MS);
  const admin = createAdminClient();
  let sent = 0;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("users")
      .select("id, plan, home_site, created_at")
      .gte("created_at", hourStart.toISOString())
      .lt("created_at", hourEnd.toISOString())
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const users = data ?? [];
    for (const user of users) {
      // How they signed up (github, google, email); a failed lookup only loses that.
      const { data: auth } = await admin.auth.admin.getUserById(user.id);
      const provider = auth?.user?.app_metadata?.provider ?? "unknown";
      captureServerEvent({
        distinctId: user.id,
        event: "account_signed_up",
        timestamp: new Date(user.created_at),
        uuid: stableEventUuid(`signup:${user.id}`),
        properties: { site: user.home_site, provider },
        set: { plan: user.plan },
        setOnce: { signed_up_at: user.created_at, signup_site: user.home_site },
      });
    }
    sent += users.length;
    await flushServerAnalyticsOrThrow();
    if (users.length < PAGE_SIZE) return sent;
  }
}

export interface DailyAccountRow {
  user_id: string;
  plan: string;
  billing_interval: string | null;
  subscription_status: string | null;
  home_site: string | null;
  signed_up_at: string;
  request_limit: number;
  requests_used: number;
  overage_active: boolean;
  captured: number;
  quota_rejected: number;
  bytes: number;
  endpoints_with_traffic: number;
  first_capture: boolean;
  audited_actions: number;
  api_reads: number;
  /** Reads per client name, from analytics_api_reads. */
  api_reads_by_client: Record<string, number> | null;
  endpoints_count: number;
  email_endpoints_count: number;
  layout_endpoints_count: number;
  destinations_count: number;
  verified_domains_count: number;
  api_keys_count: number;
  connected_agents_count: number;
  teams_count: number;
}

/**
 * The events for one account's day: its usage, its reads per client, and its
 * first capture when it was that day.
 */
export function dailyAccountEvents(day: string, row: DailyAccountRow): ServerEvent[] {
  const timestamp = new Date(`${day}T23:59:59.000Z`);
  const counts = (value: number | string) => Number(value);
  const usage: ServerEvent = {
    distinctId: row.user_id,
    event: "usage_daily",
    timestamp,
    uuid: stableEventUuid(`daily:${row.user_id}:${day}`),
    properties: {
      day,
      captured: counts(row.captured),
      quota_rejected: counts(row.quota_rejected),
      bytes: counts(row.bytes),
      endpoints_with_traffic: counts(row.endpoints_with_traffic),
      audited_actions: counts(row.audited_actions),
      api_reads: counts(row.api_reads ?? 0),
    },
    set: {
      plan: row.plan,
      billing_interval: row.billing_interval,
      subscription_status: row.subscription_status,
      home_site: row.home_site,
      request_limit: row.request_limit,
      requests_used: row.requests_used,
      overage_active: row.overage_active,
      endpoints_count: counts(row.endpoints_count),
      email_endpoints_count: counts(row.email_endpoints_count),
      layout_endpoints_count: counts(row.layout_endpoints_count),
      destinations_count: counts(row.destinations_count),
      verified_domains_count: counts(row.verified_domains_count),
      api_keys_count: counts(row.api_keys_count),
      connected_agents_count: counts(row.connected_agents_count),
      teams_count: counts(row.teams_count),
    },
    setOnce: { signed_up_at: row.signed_up_at },
  };
  const events = [usage];
  // One event per client, so a chart can sum reads broken down by client
  // next to the audit events, which carry the same client names.
  for (const [client, reads] of Object.entries(row.api_reads_by_client ?? {}).sort()) {
    if (!(counts(reads) > 0)) continue;
    events.push({
      distinctId: row.user_id,
      event: "api_reads_daily",
      timestamp,
      uuid: stableEventUuid(`api-reads:${row.user_id}:${day}:${client}`),
      properties: { day, client, reads: counts(reads) },
    });
  }
  if (row.first_capture) {
    events.push({
      distinctId: row.user_id,
      event: "first_request_captured",
      timestamp,
      uuid: stableEventUuid(`first-capture:${row.user_id}`),
      properties: { day },
      setOnce: { first_capture_day: day },
    });
  }
  return events;
}

async function sendDailyUsage(dayStart: Date): Promise<number> {
  const day = dayStart.toISOString().slice(0, 10);
  const admin = createAdminClient();
  let sent = 0;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .rpc("analytics_daily_accounts", { p_day: day })
      .order("user_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as DailyAccountRow[];
    for (const row of rows) {
      for (const event of dailyAccountEvents(day, row)) captureServerEvent(event);
    }
    sent += rows.length;
    // Out before the next page, so the queue never holds more than one, and
    // a refused batch gives the period back.
    await flushServerAnalyticsOrThrow();
    if (rows.length < PAGE_SIZE) return sent;
  }
}

/** Gives a period back after a failed read or send, so the next tick tries it again. */
async function release(report: Report, periodStart: Date): Promise<void> {
  const { error } = await createAdminClient()
    .from("analytics_report_runs")
    .delete()
    .eq("report", report)
    .eq("period_start", periodStart.toISOString());
  if (error) {
    // The claim stays, so the period is skipped: a gap in a chart, said out loud.
    reportError("[analytics] could not release a report period", error.message, {
      report,
      period: periodStart.toISOString(),
    });
  }
}

async function runReport(report: Report, now: Date): Promise<void> {
  const periods = duePeriods(now, report);
  const done = await claimedPeriods(report, periods[0]);
  for (const period of periods) {
    if (done.has(period.getTime())) continue;
    if (!(await claim(report, period))) continue;
    let sent: number;
    try {
      sent = report === "signups" ? await sendSignups(period) : await sendDailyUsage(period);
    } catch (error) {
      // Tried again whole on the next tick. Pages already sent go again
      // with the same ids and timestamps, so PostHog drops the repeats.
      await release(report, period).catch(() => undefined);
      throw error;
    }
    if (sent) console.info(`[analytics] ${report} ${period.toISOString()} sent=${sent}`);
  }
}

const globalForReporter = globalThis as unknown as { __analyticsReporter?: NodeJS.Timeout };

export function startAnalyticsReporter(): void {
  if (globalForReporter.__analyticsReporter || !serverAnalyticsEnabled()) return;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const report of ["signups", "daily_usage"] as const) {
        try {
          await runReport(report, new Date());
        } catch (error) {
          reportError("[analytics] report failed", error, { report });
        }
      }
      await flushServerAnalytics();
    } finally {
      running = false;
    }
  };

  setTimeout(() => void tick(), FIRST_TICK_MS).unref();
  globalForReporter.__analyticsReporter = setInterval(() => void tick(), TICK_MS);
  globalForReporter.__analyticsReporter.unref();
}
