import { serverAnalyticsEnabled, requestClient } from "@/lib/analytics-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";
import type { Json } from "@/lib/supabase/database";

/**
 * Read calls per account, UTC day and client (migration 00089), for the daily
 * analytics report: reads are not audited, so without these the SDKs, the CLI
 * and the MCP servers would only show up when they change something.
 *
 * Counting is in memory and costs nothing per request but a map update. Every
 * minute each process adds what it counted to analytics_api_reads in one
 * statement, one row per account, day and client, so the database sees a
 * handful of upserts a minute however busy the API is, and several processes
 * add up. A process that stops loses at most its last minute of counts, which
 * a count for analytics can afford. Nothing reaches PostHog from here: the
 * daily report (lib/analytics-reporter.ts) sends the day's totals.
 */

const FLUSH_MS = 60_000;
/** Distinct (account, day, client) keys held between flushes; past it new keys are dropped. */
const MAX_KEYS = 20_000;

type Via = "api_key" | "agent_token";

const globalForReads = globalThis as unknown as {
  __apiReads?: { counts: Map<string, number>; timer: NodeJS.Timeout | null; flushing: boolean };
};

function state() {
  globalForReads.__apiReads ??= { counts: new Map(), timer: null, flushing: false };
  return globalForReads.__apiReads;
}

/** Only reads: writes are counted by the audit trail, which carries the client too. */
function isRead(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * Counts one API call made with an API key or agent token, when it is a read
 * by an account. Browser sessions are left out (the dashboard has its own
 * analytics), and so are agents' sandbox tokens, which have no account yet.
 */
export function countApiRead(input: {
  method: string;
  userAgent: string | null;
  userId: string | null;
  via: Via;
  now?: Date;
}): void {
  if (!input.userId || !isRead(input.method) || !serverAnalyticsEnabled()) return;
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  const key = `${input.userId}\t${day}\t${requestClient(input.via, input.userAgent)}`;
  const s = state();
  const current = s.counts.get(key);
  if (current === undefined && s.counts.size >= MAX_KEYS) return;
  s.counts.set(key, (current ?? 0) + 1);
  if (!s.timer) {
    s.timer = setInterval(() => void flushApiReads(), FLUSH_MS);
    s.timer.unref();
  }
}

export interface ApiReadRow {
  user_id: string;
  day: string;
  client: string;
  reads: number;
}

/** Takes what has been counted so far, leaving the counter empty. */
export function takeApiReads(): ApiReadRow[] {
  const s = state();
  const rows: ApiReadRow[] = [];
  for (const [key, reads] of s.counts) {
    const [user_id, day, client] = key.split("\t");
    rows.push({ user_id, day, client, reads });
  }
  s.counts.clear();
  return rows;
}

/** Puts counts back after a failed write, so the next flush tries them again. */
function restore(rows: ApiReadRow[]): void {
  const s = state();
  for (const row of rows) {
    const key = `${row.user_id}\t${row.day}\t${row.client}`;
    const current = s.counts.get(key);
    if (current === undefined && s.counts.size >= MAX_KEYS) continue;
    s.counts.set(key, (current ?? 0) + row.reads);
  }
}

/** Adds the counts to the database; never throws. */
export async function flushApiReads(): Promise<void> {
  const s = state();
  if (s.flushing || s.counts.size === 0) return;
  s.flushing = true;
  const rows = takeApiReads();
  try {
    const { error } = await createAdminClient().rpc("analytics_add_api_reads", {
      p_rows: rows as unknown as Json,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    restore(rows);
    reportError("[analytics] could not store API read counts", error);
  } finally {
    s.flushing = false;
  }
}
