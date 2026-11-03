import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database";
import { createPolarClient, loggablePolarError } from "@/lib/polar";
import { reportError } from "@/lib/observability";

/**
 * The ops overview's numbers. ops_rollup_day() (migration 00087) writes one
 * row per UTC day into ops_daily_metrics, leaving staff and internal
 * accounts out; this module runs it once an hour (the day just ended with a
 * snapshot of the paying accounts, any missing day of the last five weeks
 * without one) and adds Polar's revenue figures to each day. The page
 * reads that table and a cheap "today so far", never the large tables.
 */

type MetricsRow = Database["public"]["Tables"]["ops_daily_metrics"]["Row"];

const BACKFILL_DAYS = 35;
const POLL_MS = 60 * 60 * 1000;

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDay(date);
}

/** Fills in the rollups: yesterday (with its snapshot), then gaps. */
export async function runOpsRollups(now = new Date()): Promise<number> {
  const admin = createAdminClient();
  const yesterday = addDays(utcDay(now), -1);
  const from = addDays(yesterday, -BACKFILL_DAYS + 1);
  const { data: existing, error } = await admin
    .from("ops_daily_metrics")
    .select("day, paid_accounts")
    .gte("day", from);
  if (error) throw error;
  const have = new Map((existing ?? []).map((row) => [row.day, row]));

  let written = 0;
  for (let day = from; day <= yesterday; day = addDays(day, 1)) {
    const row = have.get(day);
    // Yesterday is rewritten every hour until it has its snapshot of the
    // paying accounts, and for the first two hours of the day anyway: late
    // counters land in endpoint_daily_stats for a while after midnight.
    const isYesterday = day === yesterday;
    if (row && !isYesterday) continue;
    if (row && row.paid_accounts !== null && now.getUTCHours() >= 2) continue;
    const { error: rollupError } = await admin.rpc("ops_rollup_day", {
      p_day: day,
      // The paying accounts as they are now stand for the end of yesterday.
      // Best taken right after midnight; a process that was down then takes
      // it later rather than leaving the day without one.
      p_snapshot: isYesterday && (!row || row.paid_accounts === null || now.getUTCHours() < 2),
    });
    if (rollupError) throw rollupError;
    written++;
  }
  await fillPolarMetrics(from, yesterday);
  return written;
}

/** Polar's MRR and subscription counts per day, when Polar is configured. */
async function fillPolarMetrics(from: string, to: string): Promise<void> {
  if (!process.env.POLAR_ACCESS_TOKEN) return;
  const admin = createAdminClient();
  const { data: missing, error } = await admin
    .from("ops_daily_metrics")
    .select("day")
    .gte("day", from)
    .lte("day", to)
    .is("mrr_cents", null);
  if (error) throw error;
  if (!missing || missing.length === 0) return;

  let periods: {
    timestamp: string;
    monthly_recurring_revenue?: number | null;
    new_subscriptions?: number | null;
    canceled_subscriptions?: number | null;
  }[];
  try {
    const response = await createPolarClient().metrics.get({
      start_date: from,
      end_date: to,
      interval: "day",
      timezone: "UTC",
      metrics: ["monthly_recurring_revenue", "new_subscriptions", "canceled_subscriptions"],
    });
    periods = response.periods;
  } catch (polarError) {
    reportError("[ops] Polar metrics failed", loggablePolarError(polarError));
    return;
  }
  const wanted = new Set(missing.map((row) => row.day));
  for (const period of periods) {
    const day = period.timestamp.slice(0, 10);
    if (!wanted.has(day)) continue;
    const { error: updateError } = await admin
      .from("ops_daily_metrics")
      .update({
        mrr_cents: Math.round(period.monthly_recurring_revenue ?? 0),
        new_subscriptions: period.new_subscriptions ?? 0,
        canceled_subscriptions: period.canceled_subscriptions ?? 0,
      })
      .eq("day", day);
    if (updateError) throw updateError;
  }
}

const globalForOps = globalThis as unknown as { __opsRollups?: ReturnType<typeof setInterval> };

/** Starts the hourly rollup once per process. Called from instrumentation.ts. */
export function startOpsRollups(): void {
  if (globalForOps.__opsRollups) return;
  const tick = async () => {
    try {
      await runOpsRollups();
    } catch (error) {
      // A database without migration 00087 has no rollup to run yet.
      const message = error instanceof Error ? error.message : String(error);
      if (/ops_rollup_day|ops_daily_metrics/.test(message)) return;
      reportError("[ops] rollup failed", error);
    }
  };
  globalForOps.__opsRollups = setInterval(tick, POLL_MS);
  globalForOps.__opsRollups.unref();
  void tick();
}

export interface MetricLine {
  key: string;
  label: string;
  /** "count", "percent" (0..1) or "cents". */
  format: "count" | "percent" | "cents";
  /** Whether a rise is good (signups) or bad (refused captures). */
  higherIsBetter: boolean;
  yesterday: number | null;
  avg7: number | null;
  prev7: number | null;
  /** The last 28 days, oldest first; null where there is no value. */
  series: (number | null)[];
}

export interface OpsOverview {
  yesterday: string;
  totals: { accounts: number; endpoints: number; webhooks: number };
  today: { signups: number; captured: number; activeAccounts: number; asOf: string };
  lines: MetricLine[];
  needs: {
    tickets: { number: number; subject: string; waitingSince: string; blocking: boolean }[];
    refunds: {
      id: string;
      plannedCents: number | null;
      reason: string | null;
      createdAt: string;
    }[];
  };
}

function average(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

export function buildLines(rows: MetricsRow[], yesterday: string): MetricLine[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days = Array.from({ length: 28 }, (_, i) => addDays(yesterday, i - 27));
  const pick = (fn: (row: MetricsRow) => number | null) =>
    days.map((day) => {
      const row = byDay.get(day);
      return row ? fn(row) : null;
    });

  const make = (
    key: string,
    label: string,
    format: MetricLine["format"],
    higherIsBetter: boolean,
    fn: (row: MetricsRow) => number | null,
    /** Point values (a level like MRR) take the last value, not the average. */
    level = false
  ): MetricLine => {
    const series = pick(fn);
    const last7 = series.slice(21, 28);
    const before7 = series.slice(14, 21);
    return {
      key,
      label,
      format,
      higherIsBetter,
      yesterday: series[27],
      avg7: level ? (last7.filter((v) => v !== null).at(-1) ?? null) : average(last7),
      prev7: level ? (before7.filter((v) => v !== null).at(-1) ?? null) : average(before7),
      series,
    };
  };

  return [
    make("signups", "Signups", "count", true, (row) => row.signups),
    make("activated", "Activated within 7 days", "percent", true, (row) =>
      row.cohort_signups ? (row.cohort_activated ?? 0) / row.cohort_signups : null
    ),
    make("active", "Accounts with a capture", "count", true, (row) => row.active_accounts),
    make("captured", "Requests captured", "count", true, (row) => row.captured),
    make("rejected", "Captures refused over quota", "count", false, (row) => row.quota_rejected),
    make("paid", "Paying accounts", "count", true, (row) => row.paid_accounts, true),
    make("new_paid", "New paying accounts", "count", true, (row) => row.new_paid),
    make("lost_paid", "Accounts that stopped paying", "count", false, (row) => row.lost_paid),
    make("mrr", "Monthly recurring revenue", "cents", true, (row) => row.mrr_cents, true),
    make("new_subs", "New subscriptions", "count", true, (row) => row.new_subscriptions),
    make(
      "canceled_subs",
      "Canceled subscriptions",
      "count",
      false,
      (row) => row.canceled_subscriptions
    ),
  ];
}

export async function opsOverview(now = new Date()): Promise<OpsOverview> {
  const admin = createAdminClient();
  const yesterday = addDays(utcDay(now), -1);
  const [rows, stats, today, tickets] = await Promise.all([
    admin
      .from("ops_daily_metrics")
      .select("*")
      .gte("day", addDays(yesterday, -27))
      .lte("day", yesterday),
    admin.from("site_stats").select("*").limit(1).maybeSingle(),
    admin.rpc("ops_today"),
    admin
      .from("support_tickets")
      .select("number, subject, waiting_since, blocking, snoozed_until")
      .eq("status", "open")
      .eq("waiting_on", "support")
      .eq("spam", false)
      .order("waiting_since", { ascending: true })
      .limit(20),
  ]);
  if (rows.error) throw rows.error;
  if (today.error) throw today.error;
  if (tickets.error) throw tickets.error;

  const site = (stats.data ?? {}) as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0) || 0);
  const todayRow = today.data?.[0];

  return {
    yesterday,
    totals: {
      accounts: num(site.total_users),
      endpoints: num(site.total_endpoints),
      webhooks: num(site.total_webhooks),
    },
    today: {
      signups: num(todayRow?.signups),
      captured: num(todayRow?.captured),
      activeAccounts: num(todayRow?.active_accounts),
      asOf: now.toISOString(),
    },
    lines: buildLines(rows.data ?? [], yesterday),
    needs: {
      tickets: (tickets.data ?? [])
        .filter((row) => !row.snoozed_until || new Date(row.snoozed_until) <= now)
        .map((row) => ({
          number: row.number,
          subject: row.subject,
          waitingSince: row.waiting_since,
          blocking: row.blocking,
        })),
      refunds: (await heldRefundsSafe()).map((refund) => ({
        id: refund.id,
        plannedCents: refund.plannedCents,
        reason: refund.holdReason,
        createdAt: refund.createdAt,
      })),
    },
  };
}

async function heldRefundsSafe() {
  const { listRefunds } = await import("./refunds");
  try {
    const result = await listRefunds("held");
    return result.installed ? result.refunds : [];
  } catch {
    return [];
  }
}
