import { sendEmail } from "@/lib/email/mailer";
import { createAdminClient } from "@/lib/supabase/admin";
import { inChunks } from "@/lib/supabase/in-chunks";
import { reportError } from "@/lib/observability";
import { tunnelPlanOf, tunnelPlansOf, type TunnelPlan } from "./plan";

/*
 * What visitors take from an account's previews, by the UTC month. The edge
 * counts the bytes it sends visitors and the requests it answers, and hands
 * them over with every sync (app/api/edge/sync) in numbered batches, each
 * added once by tunnel_apply_usage_batch(). Past the plan's allowance
 * (share_data_gb), the account's previews show a page saying they are paused,
 * and new shares are refused, until the month turns or the plan grows. Live
 * sessions are never counted as data: their captures count as requests.
 */

export const GB = 1024 ** 3;

/** The month a moment falls in, as its first day: "2026-11-01". */
export function monthOf(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 8) + "01";
}

/** When the month after this one starts. */
export function nextMonthStart(now = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

export function allowanceOf(plan: TunnelPlan): number {
  return plan.limits.shareDataGb * GB;
}

/** One preview's counts in a batch from the edge. */
export interface Counted {
  id: string;
  bytes: number;
  requests: number;
}

export interface Batch {
  id: string;
  usage: Counted[];
}

/** No single preview sends more than this between two syncs; anything above is not a count. */
const MOST_IN_A_BATCH = 10 * 1024 * GB;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function counted(raw: unknown): Counted[] {
  if (!Array.isArray(raw)) return [];
  const whole = (n: unknown, most: number): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= most;
  return raw
    .slice(0, 10_000)
    .filter(
      (u): u is Counted & { kind?: unknown } =>
        typeof u === "object" &&
        u !== null &&
        typeof u.id === "string" &&
        UUID.test(u.id) &&
        // The edge names the kind; only previews are counted here.
        (u.kind === undefined || u.kind === "share") &&
        whole(u.bytes, MOST_IN_A_BATCH) &&
        whole(u.requests, 10_000_000) &&
        (u.bytes > 0 || u.requests > 0)
    )
    .map((u) => ({ id: u.id, bytes: u.bytes, requests: u.requests }));
}

/** The batches in a sync's body, checked: at most 300, ids up to 80 characters. */
export function batchesOf(raw: unknown): Batch[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 300)
    .filter(
      (b): b is { id: string; usage: unknown } =>
        typeof b === "object" &&
        b !== null &&
        typeof b.id === "string" &&
        b.id.length > 0 &&
        b.id.length <= 80
    )
    .map((b) => ({ id: b.id, usage: counted(b.usage) }));
}

/**
 * Whether a database error is a passing one (the connection, a deadlock, a
 * serialization failure, too little room, a statement or lock timeout, the
 * server going down, PostgREST unable to reach Postgres): the same batch is
 * likely to go through on the next sync.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== "object") return true; // no answer at all
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string" || code === "") {
    // A fetch that failed never reached the database.
    return err instanceof TypeError;
  }
  if (/^(08|40|53|57)/.test(code)) return true; // connection, rollback, resources, operator
  if (code === "55P03") return true; // lock_not_available (lock_timeout)
  return /^PGRST00\d$/.test(code); // PostgREST could not reach Postgres
}

/**
 * Adds the edge's batches of counts. Each batch is added once: the edge sends
 * one again when it missed the answer, which may have been after it was
 * added. The account is taken from the run itself, never from the edge.
 *
 * A passing database error (isTransientDbError) is thrown, so the sync
 * answers 500 and the edge sends every batch again (adding is idempotent).
 * A batch the database refuses for good is reported and dropped, never
 * thrown: the edge resends what the sync did not confirm, oldest first, so
 * one bad batch would otherwise fail every sync (and the stops, gates and
 * pauses it carries) until the edge gave up on it. Answers how many failed.
 */
export async function recordUsage(raw: unknown, now = Date.now()): Promise<number> {
  const admin = createAdminClient();
  let failed = 0;
  let firstError: unknown = null;
  for (const batch of batchesOf(raw)) {
    let caught: unknown = null;
    try {
      const { error } = await admin.rpc("tunnel_apply_usage_batch", {
        p_batch_id: batch.id,
        p_usage: batch.usage as unknown as never,
        p_month: monthOf(now),
      });
      if (error) caught = error;
    } catch (err) {
      caught = err;
    }
    if (caught === null) continue;
    if (isTransientDbError(caught)) throw caught;
    failed += 1;
    firstError ??= caught;
  }
  if (firstError) reportError(`Failed to add ${failed} tunnel usage batch(es)`, firstError);
  return failed;
}

export interface MonthUsage {
  plan: TunnelPlan;
  /** "2026-11" */
  month: string;
  bytes: number;
  requests: number;
  allowanceBytes: number;
  resetsAt: Date;
  over: boolean;
}

/** An account's month so far, against its plan. */
export async function usageOf(
  plan: TunnelPlan,
  userId: string,
  now = Date.now()
): Promise<MonthUsage> {
  const { data, error } = await createAdminClient()
    .from("tunnel_usage")
    .select("bytes, requests")
    .eq("user_id", userId)
    .eq("month", monthOf(now))
    .maybeSingle();
  if (error) throw error;
  const bytes = Number(data?.bytes ?? 0);
  const allowanceBytes = allowanceOf(plan);
  return {
    plan,
    month: monthOf(now).slice(0, 7),
    bytes,
    requests: Number(data?.requests ?? 0),
    allowanceBytes,
    resetsAt: nextMonthStart(now),
    over: bytes >= allowanceBytes,
  };
}

function day(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

/** What the CLI and the API say when an account is past its allowance. */
export function overMessage(u: MonthUsage): string {
  const more =
    u.plan.key === "business" || u.plan.key === "team_business"
      ? ""
      : `, or move to a bigger plan for more`;
  return `You've used this month's ${u.plan.limits.shareDataGb} GB of shared data on ${u.plan.label}, so your previews are paused. They open again on ${day(u.resetsAt)}${more}.`;
}

/** The accounts past their plan's allowance this month, for the edge. */
export async function overAllowance(now = Date.now()): Promise<string[]> {
  // The smallest allowance is Free's 1 GB; nobody under it is over.
  const { data, error } = await createAdminClient()
    .from("tunnel_usage")
    .select("user_id, bytes")
    .eq("month", monthOf(now))
    .gte("bytes", GB)
    .limit(5_000);
  if (error) throw error;
  const rows = data ?? [];
  const plans = await tunnelPlansOf(
    rows.map((r) => r.user_id),
    now
  );
  return rows
    .filter((row) => {
      const plan = plans.get(row.user_id);
      return plan !== undefined && Number(row.bytes) >= allowanceOf(plan);
    })
    .map((row) => row.user_id);
}

/**
 * Tells the accounts newly past their allowance that their previews are
 * paused: once a month, by email. Never throws; a failed email is logged.
 */
export async function tellPaused(userIds: string[], now = Date.now()): Promise<void> {
  if (userIds.length === 0) return;
  const admin = createAdminClient();
  let newly: { user_id: string }[];
  try {
    newly = await inChunks(userIds, (chunk) =>
      admin
        .from("tunnel_usage")
        .update({ paused_at: new Date(now).toISOString() })
        .eq("month", monthOf(now))
        .in("user_id", chunk)
        .is("paused_at", null)
        .select("user_id")
    );
  } catch (error) {
    reportError("Failed to mark paused previews", error);
    return;
  }
  for (const { user_id: userId } of newly) {
    try {
      const [{ data: owner }, plan] = await Promise.all([
        admin.from("users").select("email").eq("id", userId).maybeSingle(),
        tunnelPlanOf(userId, now),
      ]);
      if (!owner || !plan) continue;
      const u = await usageOf(plan, userId, now);
      await sendEmail({
        to: owner.email,
        subject: "Your previews are paused until the month turns",
        text: `${overMessage(u)}\n\nLive webhook tunnels (whk tunnel --live) keep working.\n`,
        headers: { "Auto-Submitted": "auto-generated" },
      });
    } catch (err) {
      console.error("[tunnels] paused email not sent", err instanceof Error ? err.message : err);
    }
  }
}
