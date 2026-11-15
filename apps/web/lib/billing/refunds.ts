import { PolarError, PolarNetworkError } from "@polar-sh/sdk";
import type { Polar } from "@polar-sh/sdk/2026-10";
import { auditSystemEvent } from "@/lib/audit";
import { serverEnv } from "@/lib/env";
import { reportError } from "@/lib/observability";
import { createPolarClient, loggablePolarError, polarErrorCode } from "@/lib/polar";
import { createAdminClient } from "@/lib/supabase/admin";
import { asNonEmptyString, asRecord } from "@/lib/supabase/billing-shared";
import type { Database, Json, PolarRefundReason, PolarRefundStatus } from "@/lib/supabase/database";

/**
 * Refunds for Polar charges that bought nothing (migration 00086): a second
 * plan or extra-domains subscription the webhook revoked, an add-on order
 * paid for an account or team deleted meanwhile, extra domains with nothing
 * left to add them to, and a plan or team subscription whose checkout
 * completed after its account or team was deleted.
 *
 * The webhook only records one (recordRefund); the worker below does the
 * rest, so a slow or failing Polar never holds up a webhook and a refund
 * survives a crash. A row is held for a person while automatic refunds are
 * off, above the cap, or when a subscription has orders older than the
 * window; the worker first notes which orders and how much, so the review
 * sees exactly what approving would refund. Polar refuses to refund more
 * than an order has left, and before refunding an order the worker looks
 * for a refund it already made for the row (the row id rides in the
 * refund's metadata), so a retry never pays twice.
 *
 * A subscription is refunded only once Polar has it ended (ended_at set,
 * or canceled or incomplete_expired; any other status counts as live).
 * Every call site records the refund and then revokes, so the revoke has
 * normally landed by the time the worker looks; one still live (the revoke
 * failed, and the webhook or the account deletion that asked gave up or
 * will try again) would go on charging after its money came back, so it
 * stays queued for the revoke for LIVE_SUBSCRIPTION_GRACE_MS, is then held
 * for a person with `last_error` `subscription_live` and reported once, and
 * is checked again on a slow cadence (claimLiveRechecks). Once Polar has it
 * ended, a row that was only waiting for that goes back to the queue while
 * automatic refunds are on, and any other loses the flag and waits for its
 * person as before. Approving one still flagged checks Polar again.
 */

type RefundRow = Database["public"]["Tables"]["polar_refunds"]["Row"];
type PolarOrder = Awaited<ReturnType<Polar["orders"]["get"]>>;
type PolarRefund = Awaited<ReturnType<Polar["refunds"]["create"]>>;

export type RefundTarget = { order: string } | { subscription: string };

/** One order of a refund, as recorded for the review: amounts in cents, before tax. */
export interface RefundOrderLine {
  order_id: string;
  net: number;
  tax: number;
  created_at: string;
  billing_reason: string;
}

/** The reason Polar records, from ours. */
const POLAR_REASON: Record<PolarRefundReason, "duplicate" | "other"> = {
  duplicate_plan: "duplicate",
  duplicate_addon: "duplicate",
  deleted_account: "other",
  addon_not_applied: "other",
  addon_ended: "other",
};

/** Read by people in Polar's dashboard, next to the refund. */
const POLAR_COMMENT: Record<PolarRefundReason, string> = {
  duplicate_plan: "webhooks.cc: a second plan subscription, revoked",
  duplicate_addon: "webhooks.cc: a second add-on subscription, revoked",
  deleted_account: "webhooks.cc: paid after the account or team was deleted",
  addon_not_applied: "webhooks.cc: paid add-on with nothing left to apply it to",
  addon_ended: "webhooks.cc: paid add-on increase on an add-on that had ended",
};

/** The metadata key on Polar refunds that names the row they were made for. */
export const REFUND_METADATA_KEY = "webhooks_cc_refund";

/**
 * How long a row whose subscription Polar still has live stays queued for
 * the revoke its call site makes right after recording it (or for the
 * revoke the person who approved it made), before a person is asked. The
 * backoff is cut short at its end, so the last check falls on it.
 */
export const LIVE_SUBSCRIPTION_GRACE_MS = 15 * 60_000;

/** The longest wait between checks of a row held because its subscription was live. */
export const LIVE_RECHECK_MAX_MS = 60 * 60_000;

/** A subscription's orders older than this before the row was recorded need a person. */
export const SUBSCRIPTION_WINDOW_MS = 2 * 86_400_000;

const POLL_INTERVAL_MS = 60_000;
const BATCH_SIZE = 10;
const LEASE_SECONDS = 300;
/** Retries with backoff (2, 4, 8 minutes, then up to 6 hours apart): about two days. */
const MAX_ATTEMPTS = 14;

export function refundTargetKey(target: RefundTarget): string {
  return "order" in target ? `order:${target.order}` : `subscription:${target.subscription}`;
}

function parseTargetKey(key: string): RefundTarget {
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  return kind === "order" ? { order: id } : { subscription: id };
}

function refundSettings(): { auto: boolean; maxCents: number } {
  const env = serverEnv();
  return { auto: env.POLAR_AUTO_REFUNDS, maxCents: env.POLAR_AUTO_REFUND_MAX_CENTS };
}

/**
 * Records a refund for the worker, once per target: a redelivered webhook
 * records nothing new. Pending when automatic refunds are on, held for a
 * person otherwise. A failure throws, so the webhook is delivered again.
 */
export async function recordRefund(input: {
  target: RefundTarget;
  reason: PolarRefundReason;
  userId?: string | null;
  teamId?: string | null;
}): Promise<void> {
  const { auto } = refundSettings();
  const status: PolarRefundStatus = auto ? "pending" : "held";
  const { error } = await createAdminClient()
    .from("polar_refunds")
    .upsert(
      {
        target: refundTargetKey(input.target),
        reason: input.reason,
        user_id: input.teamId ? null : (input.userId ?? null),
        team_id: input.teamId ?? null,
        status,
        hold_reason: auto ? null : "manual",
      },
      { onConflict: "target", ignoreDuplicates: true }
    );
  if (error) throw error;
  console.info(`[refunds] recorded ${input.reason} (${status})`);
}

function isRefundable(order: PolarOrder): boolean {
  return (
    (order.status === "paid" || order.status === "partially_refunded") &&
    order.refundable_amount > 0
  );
}

function isAwaitingPayment(order: PolarOrder): boolean {
  return order.status === "pending" || order.status === "draft";
}

function orderLine(order: PolarOrder): RefundOrderLine {
  return {
    order_id: order.id,
    net: order.refundable_amount,
    tax: order.refundable_tax_amount,
    created_at: order.created_at,
    billing_reason: order.billing_reason,
  };
}

/** Network trouble, a timeout, rate limiting or a 5xx: worth trying again. */
export function isTransientPolarError(error: unknown): boolean {
  if (error instanceof PolarNetworkError) return true;
  const status =
    error instanceof PolarError && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status !== "number") return !(error instanceof PolarError);
  return status >= 500 || status === 429 || status === 408;
}

function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(attempts, 1) * 60_000, 6 * 3_600_000);
}

/** When a row held because its subscription was live is checked again. */
function liveRecheckAt(attempts: number): string {
  return new Date(Date.now() + Math.min(backoffMs(attempts), LIVE_RECHECK_MAX_MS)).toISOString();
}

/**
 * Whether Polar has the subscription positively ended. Paused, unpaid and
 * any status we do not know count as live: refunding one that goes on
 * charging is the mistake that cannot be taken back.
 */
export function hasSubscriptionEnded(subscription: Record<string, unknown> | null): boolean {
  if (subscription === null) return false;
  if (asNonEmptyString(subscription.ended_at) !== null) return true;
  return subscription.status === "canceled" || subscription.status === "incomplete_expired";
}

async function targetOrders(polar: Polar, target: RefundTarget): Promise<PolarOrder[]> {
  if ("order" in target) return [await polar.orders.get(target.order)];
  const page = await polar.orders.list({ subscription_id: target.subscription, limit: 100 });
  return page.items as PolarOrder[];
}

/** Refunds Polar holds for this row on an order, whatever their state (a retry after a crash). */
async function refundsMadeFor(
  polar: Polar,
  orderId: string,
  rowId: string
): Promise<PolarRefund[]> {
  const page = await polar.refunds.list({ order_id: orderId, limit: 100 });
  return (page.items as PolarRefund[]).filter(
    (refund) => refund.metadata?.[REFUND_METADATA_KEY] === rowId
  );
}

/**
 * Writes the claimed row, only while it still has the status it was claimed
 * with: a person's decision made meanwhile (a dismissal) is never
 * overwritten. Releases the lease unless the work goes on.
 */
async function updateRow(
  row: RefundRow,
  patch: Database["public"]["Tables"]["polar_refunds"]["Update"],
  release = true
): Promise<void> {
  const { error } = await createAdminClient()
    .from("polar_refunds")
    .update({
      ...patch,
      ...(release ? { lease_until: null } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", row.status);
  if (error) throw error;
}

async function hold(
  row: RefundRow,
  holdReason: "manual" | "over_cap" | "old_orders",
  lines: RefundOrderLine[],
  plannedCents: number
): Promise<void> {
  await updateRow(row, {
    status: "held",
    hold_reason: holdReason,
    approved_at: null,
    orders: lines as unknown as Json,
    planned_cents: plannedCents,
    // A wait noted on the way (a subscription live for a while) is over.
    last_error: null,
  });
  reportError("[refunds] refund held for review", undefined, {
    refundId: row.id,
    reason: row.reason,
    holdReason,
    plannedCents,
  });
}

/** Why a held row needs a person beyond its hold reason, for the review. */
export const SUBSCRIPTION_LIVE = "subscription_live";

/**
 * Holds a row whose subscription Polar still has live once its wait is over,
 * reported once. Its hold reason stays as it was (none for a row automatic
 * refunds queued), so a later check that finds it ended knows whether it was
 * only waiting for that.
 */
async function holdLive(row: RefundRow, lines: RefundOrderLine[], plannedCents: number) {
  await updateRow(row, {
    status: "held",
    approved_at: null,
    orders: lines as unknown as Json,
    planned_cents: plannedCents,
    last_error: SUBSCRIPTION_LIVE,
    next_attempt_at: liveRecheckAt(row.attempts),
  });
  reportError("[refunds] refund held for review", undefined, {
    refundId: row.id,
    reason: row.reason,
    holdReason: row.hold_reason ?? "none",
    plannedCents,
    code: SUBSCRIPTION_LIVE,
  });
}

/**
 * Checks a row held because its subscription was live again (claimed by
 * claimLiveRechecks, the flag still set). Still live: the orders are read
 * afresh for the review and the next check is set, with nothing reported
 * again. Ended: a row automatic refunds queued goes back to the queue while
 * they are on; any other loses the flag and waits for its person.
 */
async function recheckLiveHold(
  row: RefundRow,
  live: boolean,
  lines: RefundOrderLine[],
  plannedCents: number,
  awaitingPayment: boolean
): Promise<RefundOutcome> {
  if (live || (lines.length === 0 && awaitingPayment)) {
    await updateRow(row, {
      ...(lines.length > 0
        ? { orders: lines as unknown as Json, planned_cents: plannedCents }
        : {}),
      attempts: row.attempts + 1,
      next_attempt_at: liveRecheckAt(row.attempts + 1),
    });
    return "waiting";
  }
  if (lines.length === 0) {
    await updateRow(row, {
      status: "nothing",
      orders: [] as unknown as Json,
      planned_cents: 0,
      last_error: null,
      finished_at: new Date().toISOString(),
    });
    console.info(`[refunds] nothing to refund for ${row.reason}`);
    return "nothing";
  }
  if (refundSettings().auto && row.hold_reason === null) {
    // Written only while still held, so a dismissal meanwhile stands; the
    // queue checks Polar, the cap and the window again before refunding.
    await updateRow(row, {
      status: "pending",
      orders: null,
      planned_cents: null,
      last_error: null,
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
    });
    console.info(`[refunds] subscription ended, ${row.reason} queued again`);
    return "queued";
  }
  await updateRow(row, {
    hold_reason: row.hold_reason ?? "manual",
    orders: lines as unknown as Json,
    planned_cents: plannedCents,
    last_error: null,
  });
  console.info(`[refunds] subscription ended, ${row.reason} waits for review`);
  return "prepared";
}

async function fail(
  row: RefundRow,
  code: string,
  error?: unknown,
  progress?: { refundIds: string[]; refundedCents: number }
): Promise<void> {
  // What this pass already refunded is kept, so the row never reads as
  // nothing returned when some of it was.
  await updateRow(row, {
    status: "failed",
    last_error: code,
    ...(progress && progress.refundIds.length > 0
      ? { refund_ids: progress.refundIds, refunded_cents: progress.refundedCents }
      : {}),
  });
  reportError(
    "[refunds] refund failed",
    error === undefined ? undefined : loggablePolarError(error),
    {
      refundId: row.id,
      reason: row.reason,
      code,
    }
  );
}

/** Tries the row again later, or gives up on it after the last attempt. */
async function retryLater(
  row: RefundRow,
  code: string,
  waitOutcome: "retry" | "waiting",
  error?: unknown
): Promise<RefundOutcome> {
  if (row.attempts >= MAX_ATTEMPTS) {
    await fail(row, code, error);
    return "failed";
  }
  await updateRow(row, {
    last_error: code,
    next_attempt_at: new Date(Date.now() + backoffMs(row.attempts)).toISOString(),
  });
  return waitOutcome;
}

export type RefundOutcome =
  "prepared" | "held" | "refunded" | "nothing" | "waiting" | "queued" | "failed" | "retry";

/**
 * Works one claimed row. A held row is prepared for the review (which orders,
 * how much) and stays held; a pending one is refunded order by order.
 */
export async function processRefund(row: RefundRow): Promise<RefundOutcome> {
  const polar = createPolarClient();
  const target = parseTargetKey(row.target);

  let orders: PolarOrder[];
  try {
    orders = await targetOrders(polar, target);
  } catch (error) {
    if (isTransientPolarError(error)) {
      return retryLater(row, "polar_unavailable", "retry", error);
    }
    await fail(row, polarErrorCode(error) ?? "order_lookup_refused", error);
    return "failed";
  }

  // A subscription is refunded only once it has ended: one still live would
  // go on charging after its money came back.
  let subscriptionLive = false;
  if ("subscription" in target) {
    try {
      subscriptionLive = !hasSubscriptionEnded(
        asRecord(await polar.subscriptions.get(target.subscription))
      );
    } catch (error) {
      if (isTransientPolarError(error)) {
        return retryLater(row, "polar_unavailable", "retry", error);
      }
      await fail(row, polarErrorCode(error) ?? "subscription_lookup_refused", error);
      return "failed";
    }
  }

  // An approved row refunds what the person saw, nothing that came after.
  const approvedLines =
    row.approved_at && Array.isArray(row.orders)
      ? (row.orders as unknown as RefundOrderLine[])
      : null;
  if (approvedLines) {
    const approved = new Set(approvedLines.map((line) => line.order_id));
    orders = orders.filter((order) => approved.has(order.id));
  }

  const refundable = orders.filter(isRefundable);
  const lines = refundable.map(orderLine);
  const plannedCents = lines.reduce((sum, line) => sum + line.net, 0);

  if (row.status === "held" && row.last_error === SUBSCRIPTION_LIVE && Array.isArray(row.orders)) {
    return recheckLiveHold(
      row,
      subscriptionLive,
      lines,
      plannedCents,
      orders.some(isAwaitingPayment)
    );
  }

  if (refundable.length === 0 && orders.some(isAwaitingPayment)) {
    return retryLater(row, "not_paid_yet", "waiting");
  }

  // Approved with nothing prepared (only a hand-made row can be): nobody saw
  // what it would refund, so it goes back to a person with the list.
  if (row.approved_at && !approvedLines) {
    await hold(row, "manual", lines, plannedCents);
    return "held";
  }

  if (subscriptionLive && lines.length > 0 && (row.status !== "held" || row.approved_at)) {
    // Its call site revokes right after recording it (a person approving it
    // was told to revoke it first): it stays queued with the usual backoff,
    // the last wait cut short so the final check falls when the grace ends.
    const graceEnd = Date.parse(row.approved_at ?? row.created_at) + LIVE_SUBSCRIPTION_GRACE_MS;
    if (Date.now() < graceEnd && row.attempts < MAX_ATTEMPTS) {
      await updateRow(row, {
        last_error: SUBSCRIPTION_LIVE,
        next_attempt_at: new Date(
          Math.min(Date.now() + backoffMs(row.attempts), graceEnd)
        ).toISOString(),
      });
      return "waiting";
    }
    await holdLive(row, lines, plannedCents);
    return "held";
  }

  if (row.status === "held") {
    if (lines.length === 0) {
      await updateRow(row, {
        status: "nothing",
        orders: [] as unknown as Json,
        planned_cents: 0,
        finished_at: new Date().toISOString(),
      });
      console.info(`[refunds] nothing to refund for ${row.reason}`);
      return "nothing";
    }
    await updateRow(row, {
      orders: lines as unknown as Json,
      planned_cents: plannedCents,
      // The review sees it, and a slow check clears it once Polar has the
      // subscription ended; approving checks Polar again.
      ...(subscriptionLive
        ? { last_error: SUBSCRIPTION_LIVE, next_attempt_at: liveRecheckAt(row.attempts) }
        : { last_error: null }),
    });
    reportError("[refunds] refund held for review", undefined, {
      refundId: row.id,
      reason: row.reason,
      holdReason: row.hold_reason ?? "manual",
      plannedCents,
      ...(subscriptionLive ? { code: SUBSCRIPTION_LIVE } : {}),
    });
    return "prepared";
  }

  if (!row.approved_at && lines.length > 0) {
    const { auto, maxCents } = refundSettings();
    // Turned off since the row was recorded: nothing more goes out without
    // a person.
    if (!auto) {
      await hold(row, "manual", lines, plannedCents);
      return "held";
    }
    if (plannedCents > maxCents) {
      await hold(row, "over_cap", lines, plannedCents);
      return "held";
    }
    const oldest = Date.parse(row.created_at) - SUBSCRIPTION_WINDOW_MS;
    if ("subscription" in target && lines.some((line) => Date.parse(line.created_at) < oldest)) {
      await hold(row, "old_orders", lines, plannedCents);
      return "held";
    }
    // Noted before refunding, once (a retry keeps what the first pass saw),
    // so a row that fails can be reviewed.
    if (!Array.isArray(row.orders)) {
      await updateRow(
        row,
        { orders: lines as unknown as Json, planned_cents: plannedCents },
        false
      );
    }
  }

  // Orders refunded before (by this row after a crash, or by a person) are
  // checked for this row's own refunds, so they are recorded too. A refund
  // Polar still has pending is checked again later; one that failed there
  // needs a person.
  let refundedCents = 0;
  const refundIds: string[] = [];
  let pendingAtPolar = false;
  for (const order of orders) {
    if (!isRefundable(order) && order.refunded_amount === 0) continue;
    try {
      const made = await refundsMadeFor(polar, order.id, row.id);
      const succeeded = made.filter((refund) => refund.status === "succeeded");
      const pending = made.filter((refund) => refund.status === "pending");
      for (const refund of [...succeeded, ...pending]) refundIds.push(refund.id);
      for (const refund of succeeded) refundedCents += refund.amount;
      if (pending.length > 0) pendingAtPolar = true;
      if (succeeded.length > 0 || pending.length > 0) continue;
      // Failed at Polar (a closed card, say): a person decides, and once
      // they approve the row again it is tried once more.
      if (made.length > 0 && !row.approved_at) {
        await fail(row, "refund_failed_at_polar", undefined, { refundIds, refundedCents });
        return "failed";
      }
      if (!isRefundable(order)) continue;

      const refund = await polar.refunds.create({
        order_id: order.id,
        reason: POLAR_REASON[row.reason as PolarRefundReason],
        amount: order.refundable_amount,
        comment: POLAR_COMMENT[row.reason as PolarRefundReason],
        metadata: { [REFUND_METADATA_KEY]: row.id, reason: row.reason },
      });
      refundIds.push(refund.id);
      if (refund.status === "succeeded") refundedCents += refund.amount;
      else pendingAtPolar = true;
      console.info(`[refunds] refunded ${refund.amount} cents for ${row.reason}`);
      await auditSystemEvent({
        action: "billing.refund_issued",
        outcome: "ok",
        userId: row.user_id,
        teamId: row.team_id,
        targetId: order.id,
        metadata: {
          reason: row.reason,
          amount_cents: refund.amount,
          tax_cents: refund.tax_amount,
          refund_id: refund.id,
          refund_status: refund.status,
          refund_row: row.id,
        },
      });
    } catch (error) {
      if (isTransientPolarError(error)) {
        // What was refunded so far is found again by its metadata.
        return retryLater(row, "polar_unavailable", "retry", error);
      }
      // Refused: refunded meanwhile (by Polar against a chargeback, or by a
      // person) needs nothing more; anything else needs a person.
      let now: PolarOrder;
      try {
        now = await polar.orders.get(order.id);
      } catch (checkError) {
        if (isTransientPolarError(checkError)) {
          return retryLater(row, "polar_unavailable", "retry", checkError);
        }
        await fail(row, polarErrorCode(error) ?? "refund_refused", error, {
          refundIds,
          refundedCents,
        });
        return "failed";
      }
      if (now.refundable_amount === 0) continue;
      await fail(row, polarErrorCode(error) ?? "refund_refused", error, {
        refundIds,
        refundedCents,
      });
      return "failed";
    }
  }

  if (pendingAtPolar) return retryLater(row, "refund_pending", "waiting");

  const status: PolarRefundStatus = refundIds.length > 0 ? "refunded" : "nothing";
  const saved = Array.isArray(row.orders);
  await updateRow(row, {
    status,
    orders: (saved ? row.orders : lines) as Json,
    planned_cents: saved ? row.planned_cents : plannedCents,
    refunded_cents: refundedCents,
    refund_ids: refundIds,
    last_error: null,
    finished_at: new Date().toISOString(),
  });
  if (status === "nothing") console.info(`[refunds] nothing to refund for ${row.reason}`);
  return status;
}

/**
 * Leases held rows flagged `subscription_live` whose next check is due, for
 * the slow re-check: claim_polar_refunds takes only pending and unprepared
 * held rows. The lease is written only while the row is still held, flagged
 * and free, so two workers never take the same row and a decision made
 * between the read and the lease stands.
 */
export async function claimLiveRechecks(limit: number = BATCH_SIZE): Promise<RefundRow[]> {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const free = `lease_until.is.null,lease_until.lt."${now}"`;
  const { data: due, error } = await admin
    .from("polar_refunds")
    .select("id")
    .eq("status", "held")
    .eq("last_error", SUBSCRIPTION_LIVE)
    .not("orders", "is", null)
    .lte("next_attempt_at", now)
    .or(free)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  const ids = ((due ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (ids.length === 0) return [];
  const { data, error: leaseError } = await admin
    .from("polar_refunds")
    .update({
      lease_until: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString(),
      updated_at: now,
    })
    .in("id", ids)
    .eq("status", "held")
    .eq("last_error", SUBSCRIPTION_LIVE)
    .or(free)
    .select("*");
  if (leaseError) throw leaseError;
  return (data ?? []) as RefundRow[];
}

/** Claims due rows and works them; one failure never holds up the rest. */
export async function runRefunds(): Promise<Partial<Record<RefundOutcome, number>>> {
  const { data, error } = await createAdminClient().rpc("claim_polar_refunds", {
    p_limit: BATCH_SIZE,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw new Error(`claim_polar_refunds failed: ${error.message}`);
  // A failed slow check must not strand the rows just leased above.
  let rechecks: RefundRow[] = [];
  try {
    rechecks = await claimLiveRechecks();
  } catch (recheckError) {
    reportError("[refunds] live subscription recheck claim failed", recheckError);
  }

  const counts: Partial<Record<RefundOutcome, number>> = {};
  for (const row of [...(data ?? []), ...rechecks]) {
    try {
      const outcome = await processRefund(row);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    } catch (rowError) {
      // A database write failed: the lease runs out and the row comes back.
      reportError("[refunds] refund row failed", loggablePolarError(rowError), {
        refundId: row.id,
      });
    }
  }
  return counts;
}

const globalForRefunds = globalThis as unknown as { __refundWorker?: NodeJS.Timeout };

/**
 * Starts the refund loop once per process when Polar is configured. It runs
 * whether or not automatic refunds are on: held rows are prepared for the
 * review, and rows a person approved are refunded. Called from
 * instrumentation.ts.
 */
export function startRefundWorker(): void {
  if (globalForRefunds.__refundWorker || !process.env.POLAR_ACCESS_TOKEN) return;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await runRefunds();
      const summary = Object.entries(counts)
        .map(([outcome, count]) => `${outcome}=${count}`)
        .join(" ");
      if (summary) console.info(`[refunds] ${summary}`);
    } catch (error) {
      reportError("[refunds] refund poll failed", error);
    } finally {
      running = false;
    }
  };

  globalForRefunds.__refundWorker = setInterval(() => void tick(), POLL_INTERVAL_MS);
  globalForRefunds.__refundWorker.unref();
  void tick();
}
