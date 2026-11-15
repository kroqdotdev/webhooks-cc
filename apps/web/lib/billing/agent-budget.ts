import { createHmac, randomUUID } from "node:crypto";
import { auditSystemEvent, auditUserAction } from "@/lib/audit";
import { AGENT_BUDGET_RENEWAL_NOTE } from "@/lib/billing/agent-budget-words";
import type { BillingCaller } from "@/lib/billing/ask";
import {
  auditActionFor,
  BillingChangeRetry,
  canonicalJson,
  chargeCeiling,
  changeRefusalOf,
  isPaymentActionRequired,
  loadBillingQuote,
  makeBillingChange,
  PAYMENT_ACTION_REQUIRED,
  refusalOf,
  withBillingChangeLease,
  type BillingChange,
  type BillingChangeLease,
  type BillingChangeOutcome,
  type BillingChangeRequest,
  type BillingChangeRun,
  type BillingQuote,
  type BudgetFacts,
} from "@/lib/billing/change";
import { sendEmail } from "@/lib/email/mailer";
import {
  buildAgentBudgetDecreaseEmail,
  buildAgentBudgetSetEmail,
  buildAgentBudgetSpentEmail,
  buildAgentBudgetUnknownEmail,
} from "@/lib/email/agent-budget-email";
import { reportError } from "@/lib/observability";
import {
  createPolarClient,
  loggablePolarError,
  planProductId,
  teamPlanProductId,
} from "@/lib/polar";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database";
import { homeOrigin } from "@/lib/supabase/home-site";
import { cleanUntrustedName } from "@/lib/untrusted-name";

/**
 * An agent spend budget (migration 00107): per billing account (a person's
 * own plan, or a team's), the cents before tax an API key or agent token of
 * the owner may have charged at once without the owner approving each
 * change, each change counted for 30 days or more. 0 (the default) is off.
 *
 * Only changes Polar charges to the saved card at once run on it: Pro to
 * Business monthly, Teams to Team Business, and more seats. A decrease (fewer
 * seats, fewer monthly blocks) runs directly while the budget is above 0,
 * free of it. Everything else, and anything a stop or what is left refuses,
 * stays the owner's billing.change approval (lib/billing/ask.ts).
 *
 * A change counts at what it charges now (before account credit, and at
 * the most a prorated charge can move when the quote is approximate) plus
 * how much it raises the next renewal: always on a monthly subscription,
 * and on an annual one when its renewal is at most RISE_COUNTED_DAYS away
 * (budgetCostCents), so the budget bounds both; the spend then counts until
 * 30 days after that renewal, so the rise charged there stays inside a
 * window (migration 00107). When an annual renewal is further away, the
 * change counts at the larger of the two, so a seat counts at the full
 * year's price, and the budget bounds less than the charge and that
 * renewal's rise together; a renewal at most 60 days away still keeps the
 * spend counting until 30 days after it, and one further away is not
 * bounded at all. Renewals after that keep the new price, which the owner
 * is told whenever a budget is set and on every spend.
 */

export const MAX_AGENT_BUDGET_CENTS = 50_000;
export const AGENT_BUDGET_WINDOW_DAYS = 30;
/**
 * How near an annual subscription's next renewal must be for its rise to
 * count on top of the charge now (a monthly one always counts it). The
 * database keeps a spend counting until 30 days after a renewal up to 60
 * days away (take_agent_budget, migration 00107).
 */
export const RISE_COUNTED_DAYS = 31;

/** The words every place that sets a budget, and every budget email, carries. */
export { AGENT_BUDGET_RENEWAL_NOTE };

const DAY_MS = 86_400_000;

/**
 * Whether a change's renewal rise counts on top of its charge now: always
 * on a monthly subscription, whatever its period says (a renewal Polar
 * moved later must not let the rise go uncounted), and on an annual one
 * only when its next renewal (the period the quote was priced on) is at
 * most RISE_COUNTED_DAYS after the quote. An annual quote that names no
 * period does not count it.
 */
export function riseCounted(quote: BillingQuote, facts: BudgetFacts): boolean {
  if (!facts.annual) return true;
  const periodEnd = periodEndOf(quote);
  const quotedAt = Date.parse(quote.quotedAt);
  return (
    periodEnd !== null &&
    Number.isFinite(quotedAt) &&
    Date.parse(periodEnd) - quotedAt <= RISE_COUNTED_DAYS * DAY_MS
  );
}

/**
 * What a change counts against the budget: its charge now plus the rise of
 * the next renewal on a monthly subscription, or on an annual one whose
 * renewal is at most 31 days away (riseCounted); else the larger of the
 * two. The charge is taken before account credit (credit spent on it is
 * still the owner's money), and at chargeCeiling when the quote is
 * approximate (a plan switch prorated to the second).
 */
export function budgetCostCents(quote: BillingQuote, facts: BudgetFacts): number {
  const charge = quote.dueNowCents + Math.max(0, facts.creditAppliedCents);
  const counted = quote.approximate ? chargeCeiling(charge) : charge;
  const rise = renewalRiseCents(facts);
  return riseCounted(quote, facts) ? counted + rise : Math.max(counted, rise);
}

/** How much the change raises the next renewal; 0 when it does not. */
export function renewalRiseCents(facts: BudgetFacts): number {
  return Math.max(0, facts.renewalAfterCents - facts.renewalBeforeCents);
}

/** A billing account: the person's own (teamId null) or a team's, with its owner. */
export interface BudgetAccount {
  userId: string;
  teamId: string | null;
}

export interface AgentBudget {
  budgetCents: number;
  /** What the counted spends count now: taken, made, or still unsettled, until each one's countsUntil. */
  spentCents: number;
  leftCents: number;
  /** When the first counted spend stops counting, so more is left then. */
  nextReleaseAt: string | null;
  windowDays: number;
}

/** A spend as agent_budget_state lists it, read at the database's clock with spentCents. */
export interface BudgetSpendView {
  id: string;
  change: string;
  amountCents: number;
  status: "running" | "applied" | "unsettled" | "returned";
  takenAt: string;
  /** Until when it counts. */
  countsUntil: string;
  /** Whether it is in spentCents now. */
  counted: boolean;
  keyId: string | null;
}

const SPEND_STATUSES = new Set(["running", "applied", "unsettled", "returned"]);

function spendViewOf(row: Record<string, unknown>): BudgetSpendView {
  const status = String(row.status);
  return {
    id: String(row.id),
    change: String(row.description ?? ""),
    amountCents: Number(row.amount_cents ?? 0),
    status: (SPEND_STATUSES.has(status) ? status : "running") as BudgetSpendView["status"],
    takenAt: String(row.taken_at ?? ""),
    countsUntil: String(row.counts_until ?? ""),
    counted: row.counted === true,
    keyId: typeof row.key_id === "string" ? row.key_id : null,
  };
}

function accountArgs(account: BudgetAccount) {
  return account.teamId
    ? { p_user_id: null, p_team_id: account.teamId }
    : { p_user_id: account.userId, p_team_id: null };
}

export async function getAgentBudget(account: BudgetAccount): Promise<AgentBudget | null> {
  const state = await getAgentBudgetState(account);
  if (!state) return null;
  return {
    budgetCents: state.budgetCents,
    spentCents: state.spentCents,
    leftCents: state.leftCents,
    nextReleaseAt: state.nextReleaseAt,
    windowDays: state.windowDays,
  };
}

/** The budget with its spends, both from one read at the database's clock (agent_budget_state). */
export async function getAgentBudgetState(
  account: BudgetAccount
): Promise<(AgentBudget & { spends: BudgetSpendView[] }) | null> {
  const { data, error } = await createAdminClient().rpc("agent_budget_state", accountArgs(account));
  if (error) throw error;
  const state = (data ?? {}) as Record<string, unknown>;
  if (state.status !== "ok") return null;
  return {
    budgetCents: Number(state.budget ?? 0),
    spentCents: Number(state.spent ?? 0),
    leftCents: Number(state.left ?? 0),
    nextReleaseAt: typeof state.next_release === "string" ? state.next_release : null,
    windowDays: AGENT_BUDGET_WINDOW_DAYS,
    spends: Array.isArray(state.spends)
      ? (state.spends as Record<string, unknown>[]).map(spendViewOf)
      : [],
  };
}

/** A budget asked for in whole cents, or null when it is outside 0 to $500. */
export function parseBudgetCents(input: unknown): number | null {
  if (typeof input !== "number" || !Number.isInteger(input)) return null;
  if (input < 0 || input > MAX_AGENT_BUDGET_CENTS) return null;
  return input;
}

export type SetBudgetResult =
  | { status: "ok"; previousCents: number; budgetCents: number }
  | { status: "raise_needs_owner"; previousCents: number }
  | { status: "changed"; previousCents: number }
  | { status: "no_account" };

/**
 * Sets a budget. `onlyLower` (an API key or agent token) refuses a raise,
 * which needs the owner: a session, or a billing.agent_budget approval.
 * `expectedCents`, when given, is the budget the change was asked against
 * (an approved raise): when the budget is something else now, nothing is
 * set ("changed"), so an approval never undoes a lower budget set since.
 * Who may set a team's (its owner) is the caller's to check.
 */
export async function setAgentBudget(
  account: BudgetAccount,
  cents: number,
  onlyLower: boolean,
  expectedCents: number | null = null,
  /** The approval running this set: nothing is set once it was refused. */
  approvalId: string | null = null
): Promise<SetBudgetResult> {
  const { data, error } = await createAdminClient().rpc("set_agent_budget", {
    ...accountArgs(account),
    p_cents: cents,
    p_only_lower: onlyLower,
    p_expected: expectedCents,
    p_approval: approvalId,
  });
  if (error) throw error;
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.status === "ok") {
    return {
      status: "ok",
      previousCents: Number(result.previous),
      budgetCents: Number(result.budget),
    };
  }
  if (result.status === "raise_needs_owner") {
    return { status: "raise_needs_owner", previousCents: Number(result.previous) };
  }
  if (result.status === "changed") {
    return { status: "changed", previousCents: Number(result.previous) };
  }
  return { status: "no_account" };
}

// ---------------------------------------------------------------------------
// Which changes run on the budget
// ---------------------------------------------------------------------------

export type BudgetClass = "spend" | "decrease" | "approval";

function numberIn(basis: Record<string, Json>, key: string): number | null {
  const value = basis[key];
  return typeof value === "number" ? value : null;
}

/**
 * What a change is to the budget, from the change and its quote:
 *   spend     charged to the saved card at once: Pro to Business monthly,
 *             Teams to Team Business monthly, more seats
 *   decrease  fewer seats, or fewer monthly blocks, than renew now
 *   approval  everything else: any move to annual, a lower plan, cancelling,
 *             resubscribing, keeping a plan, overage, one-time blocks, more
 *             monthly blocks (checkouts), dropping a scheduled reduction
 *
 * Fewer seats while a plan change waits for the renewal (`pendingPlan`, or
 * Polar's pending product in the quote) stay an approval: Polar keeps one
 * pending update per subscription, and until that is checked in its
 * sandbox, a seat reduction might replace the waiting downgrade.
 */
export function classifyChange(
  teamId: string | null,
  change: BillingChange,
  quote: BillingQuote,
  pendingPlan = false
): BudgetClass {
  switch (change.kind) {
    case "plan": {
      const upgrade = teamId ? change.plan === "team_business" : change.plan === "business";
      return upgrade && change.interval === "month" && quote.applies === "now"
        ? "spend"
        : "approval";
    }
    case "seats": {
      if (!teamId) return "approval";
      const seats = numberIn(quote.basis, "teamSeats");
      if (seats === null) return "approval";
      if (change.seats > seats && quote.applies === "now") return "spend";
      // Fewer than renew now; a count between a scheduled reduction and
      // today's seats would raise the renewal, so it is not a decrease.
      // Ours (teamPendingSeats) and Polar's (pendingSeats) can differ for a
      // while (a webhook not here yet): the lower one is what renews.
      const scheduled = [
        numberIn(quote.basis, "teamPendingSeats"),
        numberIn(quote.basis, "pendingSeats"),
      ].filter((value): value is number => value !== null && value > 0);
      const pending = scheduled.length > 0 ? Math.min(...scheduled) : null;
      const planWaits =
        pendingPlan ||
        (typeof quote.basis.pendingProduct === "string" && quote.basis.pendingProduct !== "") ||
        (typeof quote.basis.pendingPlan === "string" && quote.basis.pendingPlan !== "");
      if (change.seats < (pending ?? seats)) return planWaits ? "approval" : "decrease";
      return "approval";
    }
    case "capacity": {
      const action = change.capacity;
      if (action.action !== "set_monthly_blocks") return "approval";
      const blocks = quote.basis.blocks as Record<string, Json> | null | undefined;
      if (!blocks || typeof blocks.units !== "number") return "approval";
      // Monthly blocks set to end renew at nothing, so nothing lowers them.
      const renews =
        blocks.cancelAtPeriodEnd === true
          ? 0
          : typeof blocks.pendingUnits === "number"
            ? blocks.pendingUnits
            : blocks.units;
      return action.blocks < renews ? "decrease" : "approval";
    }
    default:
      return "approval";
  }
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

/** What the budget path reads of a billing account. */
export interface BudgetAccountState {
  ownerId: string | null;
  budgetCents: number;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
  paid: boolean;
  addonPastDue: boolean;
  homeSite: string | null;
  /**
   * What the derived idempotency key is made of, besides the change and the
   * billing period (periodEnd, from the quote): the subscription and what
   * is waiting for its renewal, so a key follows the state it was asked on.
   */
  version: Record<string, Json>;
}

export type BudgetStop =
  | "budget_off"
  | "pre_claim"
  | "not_owner"
  | "no_subscription"
  | "past_due"
  | "change_running"
  | "over_budget"
  | "budget_currency_unsupported"
  | "budget_currency_unknown";

/** Why the budget may not be used for this account at all, or null. */
export function budgetStop(caller: BillingCaller, state: BudgetAccountState): BudgetStop | null {
  if (!caller.userId) return "pre_claim";
  if (state.ownerId !== caller.userId) return "not_owner";
  if (state.budgetCents <= 0) return "budget_off";
  if (state.subscriptionStatus === "past_due" || state.addonPastDue) return "past_due";
  if (
    !state.paid ||
    !state.subscriptionId ||
    state.subscriptionStatus !== "active" ||
    state.cancelAtPeriodEnd
  ) {
    return "no_subscription";
  }
  return null;
}

const STOP_WORDS: Record<BudgetStop, string> = {
  budget_off: "The agent budget is off (0)",
  pre_claim: "A token that is not yet connected to an account cannot spend a budget",
  not_owner: "Only the team owner's keys spend a team's budget",
  no_subscription: "The budget needs a live paid subscription",
  past_due: "A payment is past due, so nothing is charged on the budget until it is paid",
  change_running:
    "Another billing change for this account is being made, or the outcome of one made in the last 15 minutes is not known yet",
  over_budget:
    "Less is left of the agent budget than this change counts: what it charges now plus how much it raises the next renewal (on an annual plan whose renewal is more than 31 days away, the larger of the two)",
  budget_currency_unsupported:
    "The agent budget is in US dollars, and this subscription is billed in another currency, so the budget cannot pay for its changes",
  budget_currency_unknown:
    "The agent budget is in US dollars, and billing did not say which currency this subscription is billed in, so the budget cannot pay for its changes",
};

const EXHAUSTED_WORDS =
  "Nothing is left of the agent budget, so even a reduction waits for the owner's approval until some is released";

const DECREASE_OVERLAP_WORDS =
  "A seat change made on the agent budget has no known outcome yet, and this reduction would leave the team at or above the seats it asked for, so Polar's seats could not tell the two apart: the owner approves it instead";

/**
 * Whether a reduction must wait for the owner rather than run on the
 * budget, at the database's clock (agent_budget_decrease_check): "busy"
 * while a spend of the account is running or unsettled from the last 15
 * minutes, "overlap" for fewer seats at or above the target of a seat
 * spend whose outcome is not known, else null.
 */
async function decreaseBlocked(
  account: BudgetAccount,
  change: BillingChange
): Promise<"busy" | "overlap" | null> {
  const { data, error } = await createAdminClient().rpc("agent_budget_decrease_check", {
    ...accountArgs(account),
    p_seats: change.kind === "seats" ? change.seats : null,
  });
  if (error) throw error;
  return data === "busy" || data === "overlap" ? data : null;
}

async function readAccountState(account: BudgetAccount): Promise<BudgetAccountState | null> {
  const admin = createAdminClient();
  if (account.teamId) {
    const [{ data: team, error }, { data: owner, error: ownerError }] = await Promise.all([
      admin
        .from("teams")
        .select(
          "agent_budget_cents, polar_subscription_id, subscription_status, cancel_at_period_end, seats, pending_seats, pending_plan, business, billing_interval"
        )
        .eq("id", account.teamId)
        .maybeSingle(),
      admin
        .from("team_members")
        .select("user_id")
        .eq("team_id", account.teamId)
        .eq("role", "owner")
        .maybeSingle(),
    ]);
    if (error) throw error;
    if (ownerError) throw ownerError;
    if (!team) return null;
    const ownerId = owner?.user_id ?? null;
    return {
      ownerId,
      budgetCents: team.agent_budget_cents ?? 0,
      subscriptionId: team.polar_subscription_id,
      subscriptionStatus: team.subscription_status,
      cancelAtPeriodEnd: team.cancel_at_period_end ?? false,
      paid: team.polar_subscription_id !== null,
      addonPastDue: await addonPastDue({ teamId: account.teamId }),
      homeSite: ownerId ? await homeSiteOf(ownerId) : null,
      version: {
        subscriptionId: team.polar_subscription_id,
        seats: team.seats,
        pendingSeats: team.pending_seats,
        pendingPlan: team.pending_plan,
        business: team.business,
        interval: team.billing_interval,
      },
    };
  }
  const { data: user, error } = await admin
    .from("users")
    .select(
      "agent_budget_cents, plan, pending_plan, polar_subscription_id, subscription_status, cancel_at_period_end, billing_interval, home_site"
    )
    .eq("id", account.userId)
    .maybeSingle();
  if (error) throw error;
  if (!user) return null;
  return {
    ownerId: account.userId,
    budgetCents: user.agent_budget_cents ?? 0,
    subscriptionId: user.polar_subscription_id,
    subscriptionStatus: user.subscription_status,
    cancelAtPeriodEnd: user.cancel_at_period_end ?? false,
    paid: user.plan !== "free",
    addonPastDue: await addonPastDue({ userId: account.userId }),
    homeSite: user.home_site ?? null,
    version: {
      subscriptionId: user.polar_subscription_id,
      plan: user.plan,
      pendingPlan: user.pending_plan,
      interval: user.billing_interval,
    },
  };
}

async function addonPastDue(owner: { userId?: string; teamId?: string }): Promise<boolean> {
  let query = createAdminClient()
    .from("capacity_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("status", "past_due");
  query = owner.teamId ? query.eq("team_id", owner.teamId) : query.eq("user_id", owner.userId!);
  const { count, error } = await query;
  if (error) throw error;
  return (count ?? 0) > 0;
}

async function homeSiteOf(userId: string): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("users")
    .select("home_site")
    .eq("id", userId)
    .maybeSingle();
  return data?.home_site ?? null;
}

// ---------------------------------------------------------------------------
// Idempotency and Polar's state
// ---------------------------------------------------------------------------

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,200}$/;

/** The asker's Idempotency-Key header when it is usable (8 to 200 printable characters), else null. */
export function usableIdempotencyHeader(header: string | null): string | null {
  return header && IDEMPOTENCY_KEY.test(header) ? header : null;
}

/**
 * The key a spend is recorded under. With a usable Idempotency-Key header,
 * the header keyed with the billing account, so a key is only ever the
 * same key within one account (and the stored key never carries what the
 * asker sent). Without one, a key derived from the account, the change and
 * the subscription as our database and the quote hold it (`version`, with
 * the billing period), so the same request sent again (after a timeout,
 * say) finds the same spend; once the change is made and recorded, or the
 * period moves, the state moves on and a new key follows. Either way a key
 * finds only a spend that is running, unsettled or applied, never one given
 * back (take_agent_budget).
 *
 * The material is an HMAC under the service role key, which every web
 * process shares, not a bare hash: a stored key says nothing about the
 * change or header behind it to whoever reads the table.
 *
 * Rotating SUPABASE_SERVICE_ROLE_KEY changes every key made from then on,
 * and nothing else: a spend keeps counting whatever its key, so the only
 * effect is on changes in flight at the rotation, whose retry (same header,
 * or same change) derives a new key and no longer finds its spend. Such a
 * retry takes a spend of its own, or is refused as busy while the first is
 * running or unsettled; it never makes a change uncounted.
 */
export function idempotencyKeyFor(
  header: string | null,
  account: BudgetAccount,
  change: BillingChange,
  version: Record<string, Json>
): string {
  const scope = { userId: account.teamId ? null : account.userId, teamId: account.teamId };
  const usable = usableIdempotencyHeader(header);
  if (usable) {
    return `h:${keyMac(canonicalJson({ account: scope, header: usable }))}`;
  }
  return `d:${keyMac(canonicalJson({ account: scope, change, version }))}`;
}

function keyMac(material: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  return createHmac("sha256", secret).update("agent-budget-key:v1:").update(material).digest("hex");
}

/** What the Polar subscription shows once a spend's change is made. */
export type SpendTarget = { seats: number } | { productId: string };

export function spendTarget(teamId: string | null, change: BillingChange): SpendTarget | null {
  if (change.kind === "seats") return { seats: change.seats };
  if (change.kind === "plan") {
    const productId = teamId
      ? teamPlanProductId(change.plan as "team" | "team_business", change.interval)
      : planProductId(change.plan as "pro" | "business", change.interval);
    return productId ? { productId } : null;
  }
  return null;
}

/** Whether Polar's subscription is at the target already (seats or product). */
export async function polarAtTarget(subscriptionId: string, target: SpendTarget): Promise<boolean> {
  const subscription = (await createPolarClient().subscriptions.get(subscriptionId)) as unknown as {
    seats?: number | null;
    product_id?: string;
  };
  if ("seats" in target) return subscription.seats === target.seats;
  return subscription.product_id === target.productId;
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

export interface BudgetFallback {
  used: false;
  reason: BudgetStop;
  message: string;
  leftCents?: number;
  neededCents?: number;
}

export type BudgetAttempt =
  /** Not for the budget: the usual approval. */
  | { kind: "none" }
  /** For the budget, but the budget cannot pay it: the approval, with why. */
  | { kind: "fallback"; budget: BudgetFallback }
  /** Handled on the budget: answer with this. */
  | { kind: "done"; response: Response };

function fallback(reason: BudgetStop, extra: Partial<BudgetFallback> = {}): BudgetAttempt {
  return {
    kind: "fallback",
    budget: { used: false, reason, message: STOP_WORDS[reason], ...extra },
  };
}

function done(response: Response): BudgetAttempt {
  return { kind: "done", response };
}

interface SpendContext {
  request: Request;
  caller: BillingCaller;
  account: BudgetAccount;
  change: BillingChange;
  quote: BillingQuote;
  /** What the change counts against the budget (budgetCostCents). */
  costCents: number;
  facts: BudgetFacts;
  state: BudgetAccountState;
  key: string;
  /** The asker's own Idempotency-Key, echoed back; null when the key was derived. */
  headerKey: string | null;
  target: SpendTarget | null;
  /** The billing period the quote was priced on (Polar's current_period_end), when known. */
  periodEnd: string | null;
  lease: BillingChangeLease;
}

/** Changes that are never for the budget, which skip every read. */
function neverForBudget(change: BillingChange): boolean {
  return (
    change.kind === "keep_plan" ||
    change.kind === "cancel" ||
    change.kind === "resubscribe" ||
    (change.kind === "plan" && change.interval !== "month") ||
    (change.kind === "capacity" && change.capacity.action !== "set_monthly_blocks")
  );
}

/**
 * Whether a change could run on the budget at all, from the change alone:
 * a monthly plan move up, a team's seats, or a team's or account's monthly
 * blocks. Used where a quote would cost a Polar read only to say why the
 * budget did not pay (the budget is off, as it is by default).
 */
export function mayBeForBudget(teamId: string | null, change: BillingChange): boolean {
  if (neverForBudget(change)) return false;
  switch (change.kind) {
    case "plan":
      return teamId ? change.plan === "team_business" : change.plan === "business";
    case "seats":
      return teamId !== null;
    case "capacity":
      return change.capacity.action === "set_monthly_blocks";
    default:
      return false;
  }
}

interface Quoted {
  quote: BillingQuote;
  kind: BudgetClass;
  /** What a spend counts at; null when the quote cannot say (never spent from the budget). */
  facts: BudgetFacts | null;
}

/** The change quoted now and what it is to the budget; null when quoting refused it. */
async function quoteAndClassify(
  userId: string,
  teamId: string | null,
  change: BillingChange,
  pendingPlan: boolean
): Promise<Quoted | null> {
  try {
    const loaded = await loadBillingQuote(userId, { teamId, change });
    const nowMs = Date.now();
    const quote = loaded.at(nowMs);
    return {
      quote,
      kind: classifyChange(teamId, change, quote, pendingPlan),
      facts: loaded.budget ? loaded.budget(nowMs) : null,
    };
  } catch (error) {
    // A refusal is answered by the approval path, which quotes again.
    if (refusalOf(error)) return null;
    throw error;
  }
}

function periodEndOf(quote: BillingQuote): string | null {
  const value = quote.basis.periodEnd ?? quote.renewsAt;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function pendingPlanOf(state: BudgetAccountState): boolean {
  const value = state.version.pendingPlan;
  return typeof value === "string" && value !== "";
}

/**
 * Whether the subscription is billed in US dollars, the budget's unit:
 * the currency the quote loaders read with the rest of the subscription
 * (BudgetFacts.currency, beside the quote rather than in its basis), so it
 * costs no Polar read of its own. "unknown" when Polar named none.
 */
export function budgetCurrency(facts: BudgetFacts): "usd" | "other" | "unknown" {
  if (facts.currency === "usd") return "usd";
  return facts.currency === "" ? "unknown" : "other";
}

/**
 * Runs a billing change an API key or agent token asked for on the
 * account's agent budget, when the budget may pay for it; otherwise says
 * whether to fall back to the owner's approval, and why.
 *
 * A change the budget makes holds the account's billing change lease
 * (withBillingChangeLease in lib/billing/change.ts), as an approved change
 * does, so one change runs per account at a time whichever way it came,
 * and every mutating Polar call checks the lease first. The quote it is
 * made and counted at is read under the lease.
 *
 * Anything that fails before a spend is taken is reported and answered by
 * the approval path (kind "none"), which works without the budget; once a
 * spend is taken, a failure answers outcome_unknown (spendLocked).
 */
export async function trySpendFromBudget(
  request: Request,
  caller: BillingCaller,
  teamId: string | null,
  change: BillingChange
): Promise<BudgetAttempt> {
  if (!caller.keyId) return { kind: "none" };
  if (neverForBudget(change)) return { kind: "none" };
  if (!caller.userId) return fallback("pre_claim");

  const account: BudgetAccount = { userId: caller.userId, teamId };
  try {
    const state = await readAccountState(account);
    // No account, or a team the caller does not own: the approval path
    // answers it (404 or 403), as before.
    if (!state || state.ownerId !== caller.userId) return { kind: "none" };

    // The same Idempotency-Key sent again after its change was made (a
    // webhook may have moved the seats since, which a quote would refuse
    // as unchanged) is answered from its spend, before any quote.
    const replay = await replayByHeaderKey(request, account, change);
    if (replay) return done(replay);

    const stop = budgetStop(caller, state);
    if (stop === "budget_off") {
      // Off is every account's default: no quote (a Polar read) only to
      // say so; the change alone says whether the budget could have paid.
      return mayBeForBudget(teamId, change) ? fallback(stop) : { kind: "none" };
    }
    if (stop) {
      // Say why only for a change the budget could have paid.
      const quoted = await quoteAndClassify(caller.userId, teamId, change, pendingPlanOf(state));
      if (!quoted || quoted.kind === "approval") return { kind: "none" };
      return fallback(stop);
    }
  } catch (error) {
    reportError(
      "[agent-budget] reading the budget failed; asking for approval",
      loggablePolarError(error)
    );
    return { kind: "none" };
  }

  try {
    return await withBillingChangeLease(caller.userId, teamId, (lease) =>
      spendLocked(request, caller, account, change, lease)
    );
  } catch (error) {
    // The lease is held by another change (an approval or another spend),
    // or could not be taken: nothing was taken or changed.
    if (error instanceof BillingChangeRetry) {
      if (error.status === 409) return fallback("change_running");
      return done(
        Response.json({ error: error.message, code: "billing_unavailable" }, { status: 503 })
      );
    }
    // spendLocked answers every failure after a take itself, so nothing
    // was taken here: the approval path answers it.
    reportError(
      "[agent-budget] the budget path failed before a take; asking for approval",
      loggablePolarError(error)
    );
    return { kind: "none" };
  }
}

async function spendLocked(
  request: Request,
  caller: BillingCaller,
  account: BudgetAccount,
  change: BillingChange,
  lease: BillingChangeLease
): Promise<BudgetAttempt> {
  // Read again under the lease: what the key is derived from, and the stops.
  // A failure here took nothing: the approval path answers it.
  let state: BudgetAccountState | null;
  let quoted: Quoted | null;
  try {
    state = await readAccountState(account);
    if (!state || state.ownerId !== caller.userId) return { kind: "none" };
    quoted = await quoteAndClassify(caller.userId, account.teamId, change, pendingPlanOf(state));
    if (!quoted || quoted.kind === "approval") return { kind: "none" };
    const stop = budgetStop(caller, state);
    if (stop) return fallback(stop);
  } catch (error) {
    reportError(
      "[agent-budget] reading the change failed; asking for approval",
      loggablePolarError(error)
    );
    return { kind: "none" };
  }
  const { quote, kind, facts } = quoted;
  // The budget is in US dollars: a spend on a subscription billed in
  // anything else would be counted in the wrong unit, so the owner approves
  // it as usual. A decrease counts nothing, so it runs whatever the currency.
  if (kind === "spend" && facts) {
    const currency = budgetCurrency(facts);
    if (currency === "unknown") {
      // Polar always names a subscription's currency: one that does not is
      // ours to look at (reportError keeps it to one event a minute).
      reportError("[agent-budget] a subscription has no currency; asking for approval", undefined, {
        teamId: account.teamId,
      });
      return fallback("budget_currency_unknown");
    }
    if (currency === "other") return fallback("budget_currency_unsupported");
  }

  if (kind === "decrease") {
    // A reduction is not counted, so nothing about it waits on a spend; but
    // while a spend's outcome is not known, a reduction would make Polar's
    // seats read as that spend's (settle_agent_budget_from_subscription), so
    // the owner approves it instead (agent_budget_decrease_check).
    const blocked = await decreaseBlocked(account, change);
    if (blocked) {
      return {
        kind: "fallback",
        budget: {
          used: false,
          reason: "change_running",
          message: blocked === "busy" ? STOP_WORDS.change_running : DECREASE_OVERLAP_WORDS,
        },
      };
    }
    // A budget with nothing left authorises nothing, reductions included.
    const budget = await getAgentBudget(account);
    if (!budget || budget.leftCents <= 0) {
      return {
        kind: "fallback",
        budget: {
          used: false,
          reason: "over_budget",
          message: EXHAUSTED_WORDS,
          leftCents: 0,
          neededCents: 0,
        },
      };
    }
    return done(await runDecrease(request, caller, account, change, quote, lease));
  }
  // A spend the quote cannot cost (no renewal facts) is the owner's to approve.
  if (!facts) return { kind: "none" };

  const periodEnd = periodEndOf(quote);
  const headerKey = usableIdempotencyHeader(request.headers.get("idempotency-key"));
  const key = idempotencyKeyFor(headerKey, account, change, { ...state.version, periodEnd });
  const target = spendTarget(account.teamId, change);
  if (!target || !state.subscriptionId) return fallback("no_subscription");
  const context: SpendContext = {
    request,
    caller,
    account,
    change,
    quote,
    costCents: budgetCostCents(quote, facts),
    facts,
    state,
    key,
    headerKey,
    target,
    periodEnd,
    lease,
  };

  // At most twice: a derived key whose applied spend may not be replayed
  // is moved aside, and the change takes a spend of its own.
  for (let attempt = 0; attempt < 2; attempt++) {
    let take: Record<string, unknown>;
    const spendId = randomUUID();
    try {
      take = await takeSpend(context, spendId);
    } catch (error) {
      // The take's answer was lost: it may have taken a spend under the id
      // it was given, running with no run. Nothing reached Polar, so that
      // spend is given back before the approval path answers.
      reportError("[agent-budget] the take failed; asking for approval", error);
      await returnLostTake(spendId, account);
      return { kind: "none" };
    }
    switch (take.status) {
      case "off":
        return fallback("budget_off");
      case "busy":
        return fallback("change_running");
      case "over":
        return fallback("over_budget", {
          leftCents: Number(take.left ?? 0),
          neededCents: Number(take.needed ?? context.costCents),
        });
      case "key_reused":
        return done(
          Response.json(
            { error: KEY_REUSED_WORDS, code: "idempotency_key_reused" },
            { status: 409 }
          )
        );
      case "existing": {
        const resumed = await afterTake(context, String(take.id), () => resumeSpend(context, take));
        if (resumed === "retake") continue;
        return done(resumed);
      }
      case "taken":
        return done(
          await afterTake(context, String(take.id), () =>
            runSpend(context, String(take.id), Number(take.left ?? 0), false)
          )
        );
      default:
        return { kind: "none" };
    }
  }
  return done(runningResponse(context));
}

/**
 * Runs what follows a take. A spend is taken, so whatever throws from here
 * (a settle, an audit write, a read) may come after Polar was asked: the
 * spend is kept counted as unsettled where that can still be recorded, the
 * owner is told it may have been charged, and the asker gets
 * outcome_unknown, never a plain failure.
 */
async function afterTake<T>(
  context: SpendContext,
  id: string,
  run: () => Promise<T>
): Promise<T | Response> {
  try {
    return await run();
  } catch (error) {
    // An outcome the run knew but could not record (the bank wants the
    // cardholder to confirm) is recorded here, so a retry of the same
    // request reads it and never sends the change a second time.
    const kept = error instanceof UnrecordedOutcome ? error : null;
    reportError(
      "[agent-budget] a spend failed after it was taken",
      loggablePolarError(kept ? kept.original : error)
    );
    let settleError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await settle(id, "unsettled", kept ? kept.outcome : null);
        settleError = null;
        break;
      } catch (thrown) {
        settleError = thrown;
      }
    }
    if (settleError) {
      reportError("[agent-budget] could not keep a failed spend unsettled", settleError);
    }
    await tellOwner(id, "unknown");
    return unknownResponse(context, kept ? kept.words : OUTCOME_UNKNOWN_WORDS);
  }
}

/**
 * A spend's outcome that a run knows but whose settle failed: thrown to
 * afterTake, which records it (kept unsettled with this outcome) and
 * answers with these words.
 */
class UnrecordedOutcome extends Error {
  constructor(
    readonly outcome: Json,
    readonly words: string,
    readonly original: unknown
  ) {
    super("A spend's outcome could not be recorded");
    this.name = "UnrecordedOutcome";
  }
}

/** What a spend the bank wants the cardholder to confirm keeps (3-D Secure). */
const PAYMENT_ACTION_OUTCOME: Json = { code: "payment_action_required" };

/** How long returnLostTake waits before it looks a second time. */
export const LOST_TAKE_RECHECK_MS = 500;

/**
 * Gives back a spend a take may have made under `id` when its answer was
 * lost: looked up, and when not found, once more after LOST_TAKE_RECHECK_MS
 * (a take still waiting on the account row's lock commits after the first
 * look); when still not found, the id is marked with a row given back
 * already (bury_lost_agent_budget_take), so a take that arrives later
 * fails on the primary key and takes nothing. A spend found running is
 * settled as returned (nothing was sent to Polar for it). Never throws: a
 * spend left running keeps counting until a retry of the same change looks
 * at it again.
 */
export async function returnLostTake(id: string, account: BudgetAccount): Promise<void> {
  try {
    let status = await spendStatus(id);
    if (status === null) {
      await new Promise((resolve) => setTimeout(resolve, LOST_TAKE_RECHECK_MS));
      status = await spendStatus(id);
    }
    if (status === null) {
      const { data, error } = await createAdminClient().rpc("bury_lost_agent_budget_take", {
        p_id: id,
        ...accountArgs(account),
      });
      if (error) throw error;
      status = (data as string | null) ?? null;
    }
    if (status === "running") await settle(id, "returned", null);
  } catch (error) {
    reportError("[agent-budget] could not give back a take whose answer was lost", error);
  }
}

async function spendStatus(id: string): Promise<string | null> {
  const { data: row, error } = await createAdminClient()
    .from("agent_budget_spends")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return row?.status ?? null;
}

async function takeSpend(context: SpendContext, id: string): Promise<Record<string, unknown>> {
  const { account, caller, change, quote, state, key, target, periodEnd, facts } = context;
  const { data, error } = await createAdminClient().rpc("take_agent_budget", {
    ...accountArgs(account),
    p_idempotency_key: key,
    p_cents: context.costCents,
    p_key_id: caller.keyId ?? null,
    p_agent_registration_id: caller.agentRegistrationId ?? null,
    p_change: change as unknown as Json,
    p_description: quote.change.slice(0, 500),
    p_subscription_id: state.subscriptionId!,
    p_target: target as unknown as Json,
    p_period_end: periodEnd,
    p_facts: {
      chargeCents: quote.dueNowCents,
      approximate: quote.approximate,
      renewalCents: quote.renewalCents,
      renewalRiseCents: renewalRiseCents(facts),
      annual: facts.annual,
      riseCounted: riseCounted(quote, facts),
    },
    p_id: id,
  });
  if (error) throw error;
  return (data ?? {}) as Record<string, unknown>;
}

function runningResponse(context: SpendContext): Response {
  return Response.json(
    {
      error: "This change is being made already. Ask again in a minute.",
      code: "change_running",
      ...(context.headerKey ? { idempotencyKey: context.headerKey } : {}),
    },
    { status: 409 }
  );
}

/** How long an applied spend found by a derived key is answered again, rather than taken anew. */
export const REPLAY_MAX_AGE_SECONDS = 24 * 60 * 60;
/** How long after it was taken a spend whose outcome is not known may be sent to Polar again. */
export const RESEND_MAX_AGE_SECONDS = 10 * 60;

/** An earlier spend with the same key, as take_agent_budget answers `existing`. */
export interface ExistingSpend {
  ageSeconds: number;
  quotedCents: number;
  amountCents: number;
  periodEnd: string | null;
  budgetCents: number;
  /** What the account's other spends count now. */
  othersCents: number;
}

export function existingSpendOf(take: Record<string, unknown>): ExistingSpend {
  return {
    ageSeconds: Number(take.age_seconds ?? Number.POSITIVE_INFINITY),
    quotedCents: Number(take.quoted_cents ?? 0),
    amountCents: Number(take.amount_cents ?? 0),
    periodEnd: typeof take.period_end === "string" ? take.period_end : null,
    budgetCents: Number(take.budget ?? 0),
    othersCents: Number(take.others ?? 0),
  };
}

export type ResendRefusal = "too_old" | "period_moved" | "price_rose" | "over_budget";

/**
 * Why a spend whose outcome is not known may not be sent to Polar again at
 * today's quote, or null when it may: it was taken more than
 * RESEND_MAX_AGE_SECONDS ago, the billing period moved, today's cost is
 * above what time alone moves the counted amount (chargeCeiling), or the
 * budget, less the account's other spends, no longer covers it.
 */
export function resendRefusal(
  existing: ExistingSpend,
  fresh: { costCents: number; periodEnd: string | null }
): ResendRefusal | null {
  if (!(existing.ageSeconds <= RESEND_MAX_AGE_SECONDS)) return "too_old";
  if (
    !existing.periodEnd ||
    !fresh.periodEnd ||
    Date.parse(existing.periodEnd) !== Date.parse(fresh.periodEnd)
  ) {
    return "period_moved";
  }
  if (fresh.costCents > chargeCeiling(existing.quotedCents)) return "price_rose";
  if (existing.budgetCents - existing.othersCents < fresh.costCents) return "over_budget";
  return null;
}

const RESEND_REFUSED_WORDS =
  "The change may or may not have been made by the earlier request, and it is not sent again from the agent budget: too long has passed since, or the price, the billing period or what is left of the budget changed. It stays counted for 30 days unless Polar shows it was made. Check billing; if it was not made, ask for it again with a new Idempotency-Key.";

/**
 * A spend taken by an earlier request with the same key: answered again
 * when it was made, looked at again (one request at a time) when its outcome
 * is not known, and sent again only while resendRefusal allows it.
 * "retake" means the key was moved aside and the change takes a new spend.
 */
async function resumeSpend(
  context: SpendContext,
  take: Record<string, unknown>
): Promise<Response | "retake"> {
  const id = String(take.id);
  const existing = existingSpendOf(take);
  if (take.spend_status === "applied") {
    // A derived key answers an applied spend again only within a day, and
    // only while Polar still shows its change: otherwise the same change
    // asked for again (the owner undid it, say) is a new change.
    if (!context.headerKey) {
      let replay = existing.ageSeconds <= REPLAY_MAX_AGE_SECONDS;
      if (replay) {
        try {
          replay = await polarAtTarget(context.state.subscriptionId!, context.target!);
        } catch (readError) {
          reportError(
            "[agent-budget] could not read the subscription before a replay",
            loggablePolarError(readError)
          );
          return Response.json(
            { error: "Could not read the subscription. Ask again.", code: "billing_unavailable" },
            { status: 503 }
          );
        }
      }
      if (!replay) {
        const { error } = await createAdminClient().rpc("retire_agent_budget_key", { p_id: id });
        if (error) throw error;
        return "retake";
      }
    }
    return replayResponse(id, take.outcome);
  }
  if (take.spend_status === "running" && take.stale !== true) return runningResponse(context);
  // Sent again only at the quote it was counted at, in its period, while
  // the budget still covers it: else it stays counted and is not resent.
  const refusal = resendRefusal(existing, {
    costCents: context.costCents,
    periodEnd: context.periodEnd,
  });
  // A payment the bank wants confirmed (3-D Secure) may still be taken once
  // the cardholder confirms it: never asked for a second time from here.
  const earlier = (take.outcome ?? {}) as Record<string, unknown>;
  const awaitingCardholder = earlier.code === "payment_action_required";
  // Unsettled (the outcome is not known), or abandoned by a run that died:
  // one request at a time looks again. A spend that will be sent again is
  // counted at no less than today's cost, the quote a resend is made at;
  // one that will not (p_cents null) is only looked at, which moves none
  // of its windows.
  const { data, error } = await createAdminClient().rpc("claim_agent_budget_retry", {
    p_id: id,
    p_cents: refusal || awaitingCardholder ? null : context.costCents,
  });
  if (error) throw error;
  const claimed = (data ?? null) as { amount?: unknown; resend?: unknown } | null;
  if (!claimed || typeof claimed.amount !== "number") return runningResponse(context);
  const countedCents = claimed.amount;
  // The claim checks the budget again under the account's lock: one lowered
  // since the read above leaves the try only a look, never a resend.
  const lowered = refusal === null && !awaitingCardholder && claimed.resend !== true;
  const refused: ResendRefusal | null = refusal ?? (lowered ? "over_budget" : null);
  // What is left after this spend: from the take's read, unless the claim
  // found the budget lowered since, when that read's budget is stale and a
  // fresh read says what is left.
  const left = lowered
    ? await leftNow(context.account)
    : Math.max(0, existing.budgetCents - existing.othersCents - countedCents);
  // Polar has no idempotency key: if the subscription is at the target
  // already, the first try was made, and sending it again would only
  // repeat it.
  try {
    if (await polarAtTarget(context.state.subscriptionId!, context.target!)) {
      // Made by the first try: answered with what the row counts.
      return finishSpend(
        { ...context, costCents: countedCents },
        id,
        { executed: true, applied: "now" },
        left
      );
    }
  } catch (readError) {
    reportError(
      "[agent-budget] could not read the subscription before a retry",
      loggablePolarError(readError)
    );
    return keepUnsettled(context, id, left, "outcome_unknown", OUTCOME_UNKNOWN_WORDS);
  }
  const counted = { ...context, costCents: countedCents };
  if (awaitingCardholder) {
    const status = await settle(id, "unsettled", null);
    if (status === "applied") return finishSpend(counted, id, MADE, left);
    return unknownResponse(context, PAYMENT_ACTION_REQUIRED);
  }
  if (refused) {
    return keepUnsettled(counted, id, left, `not_resent:${refused}`, RESEND_REFUSED_WORDS);
  }
  // A second try: whatever it finds, it never gives the spend back.
  return runSpend(counted, id, left, true);
}

/**
 * What is left of the budget now, from a fresh read (agent_budget_state),
 * or 0 when it cannot be read: an answer never says more is left than is.
 */
async function leftNow(account: BudgetAccount): Promise<number> {
  try {
    return Math.max(0, (await getAgentBudgetState(account))?.leftCents ?? 0);
  } catch {
    return 0;
  }
}

/**
 * The answer a spend made gets again: the answer its request kept, or,
 * when a webhook or an order made it first (no answer kept), one built
 * from the spend's row.
 */
async function replayResponse(id: string, kept: unknown): Promise<Response> {
  const outcome = kept as Record<string, unknown> | null | undefined;
  if (outcome && outcome.executed === true) return Response.json({ ...outcome, replayed: true });
  const { data: row, error } = await createAdminClient()
    .from("agent_budget_spends")
    .select("id, description, amount_cents, facts")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return Response.json({ ...replayBodyOf(row ?? { id }), replayed: true });
}

/** A made spend's answer from its row, for a spend no request answered. */
export function replayBodyOf(row: {
  id: string;
  description?: string | null;
  amount_cents?: number | null;
  facts?: Json | null;
}): Record<string, unknown> {
  const facts = (row.facts ?? {}) as Record<string, unknown>;
  return {
    executed: true,
    applied: "now",
    change: row.description ?? null,
    viaBudget: true,
    chargedCents: typeof facts.chargeCents === "number" ? facts.chargeCents : null,
    approximate: facts.approximate === true,
    renewalCents: typeof facts.renewalCents === "number" ? facts.renewalCents : null,
    renewalRiseCents: typeof facts.renewalRiseCents === "number" ? facts.renewalRiseCents : 0,
    countedCents: row.amount_cents ?? null,
    annual: facts.annual === true,
    riseCounted: typeof facts.riseCounted === "boolean" ? facts.riseCounted : facts.annual !== true,
    budget: { spendId: row.id },
    note: AGENT_BUDGET_RENEWAL_NOTE,
  };
}

/**
 * With the asker's own Idempotency-Key: the spend it took, when that was
 * made, is answered again before anything is quoted (a quote would refuse a
 * change the subscription shows already); the key named for another change
 * is refused. Null when there is no such spend to answer.
 */
async function replayByHeaderKey(
  request: Request,
  account: BudgetAccount,
  change: BillingChange
): Promise<Response | null> {
  const headerKey = usableIdempotencyHeader(request.headers.get("idempotency-key"));
  if (!headerKey) return null;
  const key = idempotencyKeyFor(headerKey, account, change, {});
  let query = createAdminClient()
    .from("agent_budget_spends")
    .select("id, status, change, outcome")
    .eq("idempotency_key", key)
    .neq("status", "returned");
  query = account.teamId
    ? query.eq("team_id", account.teamId)
    : query.eq("user_id", account.userId);
  const { data: row, error } = await query.maybeSingle();
  if (error) throw error;
  if (!row) return null;
  if (canonicalJson(row.change) !== canonicalJson(change)) {
    return Response.json(
      { error: KEY_REUSED_WORDS, code: "idempotency_key_reused", idempotencyKey: headerKey },
      { status: 409 }
    );
  }
  if (row.status !== "applied") return null;
  const replayed = await replayResponse(row.id, row.outcome);
  const body = (await replayed.json()) as Record<string, unknown>;
  return Response.json({ ...body, idempotencyKey: headerKey });
}

const KEY_REUSED_WORDS =
  "This Idempotency-Key was already used for a different billing change on this account. Send a new key for a new change.";

async function settle(id: string, status: "applied" | "unsettled" | "returned", outcome: Json) {
  const { data, error } = await createAdminClient().rpc("settle_agent_budget_spend", {
    p_id: id,
    p_status: status,
    p_outcome: outcome,
  });
  if (error) throw error;
  return data as string | null;
}

const OUTCOME_UNKNOWN_WORDS =
  "The change may or may not have been made: Polar was asked to make it, and then something failed. It stays counted against the agent budget for 30 days unless Polar shows it was made. Check billing before asking again; sending the same request again within a few minutes finishes it if it was not made, and charges nothing twice.";

/** An outcome that cannot be known, as PR 8's approvals answer it (`outcome_unknown`). */
function unknownResponse(context: SpendContext, reason: string): Response {
  return Response.json(
    {
      error: reason,
      code: "outcome_unknown",
      executed: null,
      reason,
      viaBudget: true,
      ...(context.headerKey ? { idempotencyKey: context.headerKey } : {}),
    },
    { status: 502 }
  );
}

/**
 * How a failed change reads for the budget, by lib/billing/change.ts's own
 * rules (runLocked):
 *   retry            nothing reached Polar (the lease ran out or the run
 *                    got too slow before its first change)
 *   refused          a refusal on the allowlist of codes raised before Polar
 *                    is asked, or a declined card (changeRefusalOf)
 *   payment_action   the bank wants the cardholder to confirm (3-D Secure)
 *   unknown          anything else: Polar may have made it
 * `retry` and `refused` give the spend back at once; the others keep it
 * counted.
 */
export function spendErrorKind(
  error: unknown,
  mutations: number
): "retry" | "refused" | "payment_action" | "unknown" {
  if (error instanceof BillingChangeRetry && mutations === 0) return "retry";
  if (changeRefusalOf(error)) return "refused";
  if (isPaymentActionRequired(error)) return "payment_action";
  return "unknown";
}

/**
 * Makes a spend's change under the lease. A change that certainly did not
 * reach Polar, or that Polar refused before charging, gives the spend back
 * at once; one whose outcome is not known keeps it counted as unsettled,
 * for the webhook or the same request sent again, and the owner is told it
 * may have been charged.
 *
 * `resumed` is a second try of a spend whose first outcome was not known:
 * the first try may have charged, so nothing this try finds (nothing sent,
 * a refusal, the change found in place) gives it back. It stays counted,
 * unsettled, until Polar shows what happened. The database holds the same
 * rule (settle_agent_budget_spend), and settles as made a spend Polar
 * already showed made (its order, or its target on the subscription).
 */
async function runSpend(
  context: SpendContext,
  id: string,
  leftCents: number,
  resumed: boolean
): Promise<Response> {
  const { caller, account, change, quote, lease } = context;
  let run: BillingChangeRun;
  try {
    run = await makeBillingChange(caller.userId, { teamId: account.teamId, change }, quote);
  } catch (error) {
    const kind = spendErrorKind(error, lease.mutations);
    if (kind === "retry" || kind === "refused") {
      const refusal = kind === "refused" ? changeRefusalOf(error)! : null;
      const code = refusal?.code ?? "lease_lost";
      if (resumed) return keepUnsettled(context, id, leftCents, code, RESEND_FAILED_WORDS);
      // The row keeps why it was given back: a declined card's charge that
      // Polar collects later brings it back (raise_agent_budget_from_order).
      const status = await settle(id, "returned", { code });
      if (status !== "returned") {
        return keepUnsettled(context, id, leftCents, code, OUTCOME_UNKNOWN_WORDS, status);
      }
      await auditSpend(context, "billing.agent_budget_returned", refusal?.status ?? 409, {
        spendId: id,
        code,
      });
      if (refusal) {
        return Response.json(
          { error: refusal.message, code: refusal.code },
          { status: refusal.status }
        );
      }
      const retry = error as BillingChangeRetry;
      return Response.json(
        {
          error: retry.message,
          code: retry.status === 409 ? "change_running" : "billing_unavailable",
        },
        { status: retry.status }
      );
    }
    if (kind === "payment_action") {
      // The mark keeps a retry from sending it again, so a settle that fails
      // hands it to afterTake to record rather than lose it.
      let status: string | null;
      try {
        status = await settle(id, "unsettled", PAYMENT_ACTION_OUTCOME);
      } catch (settleError) {
        throw new UnrecordedOutcome(PAYMENT_ACTION_OUTCOME, PAYMENT_ACTION_REQUIRED, settleError);
      }
      if (status === "applied") return finishSpend(context, id, MADE, leftCents);
      try {
        await auditSpend(context, "billing.agent_budget_spent", 402, {
          spendId: id,
          unsettled: true,
          code: "payment_action_required",
        });
      } finally {
        await tellOwner(id, "unknown");
      }
      return unknownResponse(context, PAYMENT_ACTION_REQUIRED);
    }
    reportError(
      "[agent-budget] a change on the budget has no known outcome",
      loggablePolarError(error)
    );
    return keepUnsettled(context, id, leftCents, "outcome_unknown", OUTCOME_UNKNOWN_WORDS);
  }
  const { outcome } = run;
  if (outcome.executed !== true || outcome.applied === "checkout") {
    // Made nothing (found in place already): given back, unless an earlier
    // try may have made it.
    const code = outcome.executed === false ? outcome.code : "unchanged";
    if (resumed) return keepUnsettled(context, id, leftCents, code, RESEND_FAILED_WORDS);
    const status = await settle(id, "returned", null);
    if (status !== "returned") {
      return keepUnsettled(context, id, leftCents, code, OUTCOME_UNKNOWN_WORDS, status);
    }
    await auditSpend(context, "billing.agent_budget_returned", 409, { spendId: id, code });
    return Response.json(
      { error: outcome.executed === false ? outcome.reason : "Nothing was changed.", code },
      { status: 409 }
    );
  }
  return finishSpend(context, id, outcome, leftCents);
}

/** A change made, as answered when Polar showed it rather than the run. */
const MADE: BillingChangeOutcome = { executed: true, applied: "now" };

const RESEND_FAILED_WORDS =
  "The change was sent again because the earlier request's outcome was not known, and this try did not make it. The earlier try may have, so it stays counted against the agent budget for 30 days unless Polar shows it was made. Check billing before asking again with a new Idempotency-Key.";

/**
 * Keeps a spend counted as unsettled (or made, when the database finds
 * Polar showed it: `known` is the status a settle already gave) and
 * answers outcome_unknown; the owner is told it may have been charged.
 */
async function keepUnsettled(
  context: SpendContext,
  id: string,
  leftCents: number,
  code: string,
  words: string,
  known?: string | null
): Promise<Response> {
  const status = known ?? (await settle(id, "unsettled", null));
  if (status === "applied") return finishSpend(context, id, MADE, leftCents);
  try {
    await auditSpend(context, "billing.agent_budget_spent", 502, {
      spendId: id,
      unsettled: true,
      code: "outcome_unknown",
      cause: code,
    });
  } finally {
    await tellOwner(id, "unknown");
  }
  return unknownResponse(context, words);
}

/**
 * Records a change made on the budget and answers it. The owner's email
 * goes out whatever happens to the records (a finally), since Polar has
 * made the change; one that fails to send is sent by the poller. The answer
 * says `ownerEmail: "sent"` only when this request sent it, else "queued".
 */
async function finishSpend(
  context: SpendContext,
  id: string,
  outcome: BillingChangeOutcome,
  leftCents: number
): Promise<Response> {
  const { request, caller, account, change, quote, state } = context;
  const body = {
    ...outcome,
    change: quote.change,
    viaBudget: true,
    chargedCents: quote.dueNowCents,
    approximate: quote.approximate,
    renewalCents: quote.renewalCents,
    renewalRiseCents: renewalRiseCents(context.facts),
    countedCents: context.costCents,
    annual: context.facts.annual,
    riseCounted: riseCounted(quote, context.facts),
    budget: { budgetCents: state.budgetCents, leftCents, spendId: id },
    note: AGENT_BUDGET_RENEWAL_NOTE,
  };
  let ownerEmail: "sent" | "queued" = "queued";
  try {
    await settle(id, "applied", body as unknown as Json);
    await auditSpend(context, "billing.agent_budget_spent", 200, {
      spendId: id,
      cents: context.costCents,
      chargedCents: quote.dueNowCents,
      leftCents,
    });
    // The change's own entry, as when a session or an approval makes it.
    await auditUserAction(request, caller.userId, {
      action: auditActionFor({ teamId: account.teamId, change }),
      status: 200,
      teamId: account.teamId,
      metadata: { viaBudget: true, spendId: id, ...changeMetadata(change) },
    });
  } finally {
    if (await tellOwner(id, "spent")) ownerEmail = "sent";
  }
  return Response.json({ ...body, ownerEmail });
}

/**
 * A decrease made directly while the budget is on, under the same lease:
 * nothing is charged or counted, and the owner gets a short notice.
 * Failures read as an approved change's do.
 */
async function runDecrease(
  request: Request,
  caller: BillingCaller,
  account: BudgetAccount,
  change: BillingChange,
  quote: BillingQuote,
  lease: BillingChangeLease
): Promise<Response> {
  const asked: BillingChangeRequest = { teamId: account.teamId, change };
  const auditFailure = (status: number, code: string, reason: string) =>
    auditUserAction(request, caller.userId, {
      action: auditActionFor(asked),
      status,
      reason,
      teamId: account.teamId,
      metadata: { viaBudget: true, decrease: true, code, ...changeMetadata(change) },
    });
  let run: BillingChangeRun;
  try {
    run = await makeBillingChange(caller.userId, asked, quote);
  } catch (error) {
    const kind = spendErrorKind(error, lease.mutations);
    if (kind === "refused") {
      const refusal = changeRefusalOf(error)!;
      await auditFailure(refusal.status, refusal.code, refusal.message);
      return Response.json(
        { error: refusal.message, code: refusal.code },
        { status: refusal.status }
      );
    }
    if (kind === "retry") {
      const retry = error as BillingChangeRetry;
      return Response.json(
        {
          error: retry.message,
          code: retry.status === 409 ? "change_running" : "billing_unavailable",
        },
        { status: retry.status }
      );
    }
    const reason = kind === "payment_action" ? PAYMENT_ACTION_REQUIRED : DECREASE_UNKNOWN_WORDS;
    await auditFailure(502, "outcome_unknown", reason);
    if (kind === "unknown") {
      reportError(
        "[agent-budget] a decrease on the budget has no known outcome",
        loggablePolarError(error)
      );
    }
    return Response.json(
      { error: reason, code: "outcome_unknown", executed: null, reason, viaBudget: true },
      { status: 502 }
    );
  }
  const { outcome } = run;
  if (outcome.executed !== true || outcome.applied === "checkout") {
    const code = outcome.executed === false ? outcome.code : "unchanged";
    const reason = outcome.executed === false ? outcome.reason : "Nothing was changed.";
    await auditFailure(409, code, reason);
    return Response.json({ error: reason, code }, { status: 409 });
  }
  let ownerEmail: "sent" | "queued" = "queued";
  try {
    await auditUserAction(request, caller.userId, {
      action: auditActionFor(asked),
      status: 200,
      teamId: account.teamId,
      metadata: { viaBudget: true, decrease: true, ...changeMetadata(change) },
    });
  } finally {
    ownerEmail = await recordAndNotifyDecrease(account, caller, quote);
  }
  return Response.json({
    ...outcome,
    change: quote.change,
    viaBudget: true,
    chargedCents: 0,
    renewalCents: quote.renewalCents,
    ownerEmail,
  });
}

/**
 * Records a reduction made on the budget and sends its notice when one may
 * go now (at most one an hour per account, batching the reductions since
 * the last); otherwise the poller sends it once the hour is up. Never
 * throws. When the reduction cannot be recorded, the notice is sent at
 * once on its own, so the owner still hears of it.
 */
async function recordAndNotifyDecrease(
  account: BudgetAccount,
  caller: BillingCaller,
  quote: BillingQuote
): Promise<"sent" | "queued"> {
  const keyId = caller.keyId;
  const agentRegistrationId = caller.agentRegistrationId ?? null;
  try {
    const { error } = await createAdminClient().rpc("record_agent_budget_reduction", {
      ...accountArgs(account),
      p_key_id: keyId ?? null,
      p_description: quote.change.slice(0, 500),
      p_renewal_cents: quote.renewalCents,
      p_agent_registration_id: agentRegistrationId,
    });
    if (error) throw error;
  } catch (recordError) {
    reportError("[agent-budget] could not record a reduction", recordError);
    try {
      await sendReductionEmail(account, [
        {
          keyId: keyId ?? null,
          agentRegistrationId,
          change: quote.change,
          renewalCents: quote.renewalCents,
          madeAt: new Date().toISOString(),
        },
      ]);
      return "sent";
    } catch (sendError) {
      reportError("[agent-budget] the reduction notice was not sent", sendError);
      return "queued";
    }
  }
  try {
    return (await sendReductionNotice(account)) === "sent" ? "sent" : "queued";
  } catch (error) {
    reportError("[agent-budget] the reduction notice was not sent", error);
    return "queued";
  }
}

const DECREASE_UNKNOWN_WORDS =
  "The change may or may not have been made: Polar was asked to make it, and then something failed. Check billing before asking again.";

function changeMetadata(change: BillingChange): Record<string, unknown> {
  switch (change.kind) {
    case "plan":
      return { change: "plan", plan: change.plan, interval: change.interval };
    case "seats":
      return { change: "seats", seats: change.seats };
    case "capacity":
      return { change: "capacity", ...change.capacity };
    default:
      return { change: change.kind };
  }
}

async function auditSpend(
  context: SpendContext,
  action: "billing.agent_budget_spent" | "billing.agent_budget_returned",
  status: number,
  metadata: Record<string, unknown>
): Promise<void> {
  await auditUserAction(context.request, context.caller.userId, {
    action,
    status,
    teamId: context.account.teamId,
    targetId: context.caller.keyId ?? null,
    metadata: { ...metadata, ...changeMetadata(context.change) },
  });
}

/** The longest key or agent name an email shows. */
const KEY_NAME_MAX = 80;

/**
 * How the owner's email names the key that spent: its name and prefix, or
 * the agent's name. Names were chosen by whoever made the key or the agent,
 * so they are cleaned (cleanUntrustedName: no control characters or quotes,
 * cut to KEY_NAME_MAX) before they go between the quotes here.
 */
export async function keyLabel(
  keyId: string | null | undefined,
  agentRegistrationId?: string | null
): Promise<string> {
  const admin = createAdminClient();
  if (keyId) {
    const { data } = await admin
      .from("api_keys")
      .select("name, key_prefix, is_agent_issued, client_name")
      .eq("id", keyId)
      .maybeSingle();
    if (data) return keyLabelOf(data);
  }
  // An agent token is short-lived and its row goes when it expires: the
  // agent is named from its registration, which outlives its tokens.
  if (agentRegistrationId) {
    const { data } = await admin
      .from("agent_registrations")
      .select("client_name")
      .eq("id", agentRegistrationId)
      .maybeSingle();
    const name = cleanUntrustedName(data?.client_name ?? "", KEY_NAME_MAX);
    return name ? `the agent "${name}"` : "an agent";
  }
  return "an API key";
}

export function keyLabelOf(key: {
  name: string | null;
  key_prefix: string | null;
  is_agent_issued: boolean | null;
  client_name: string | null;
}): string {
  if (key.is_agent_issued) {
    const name = cleanUntrustedName(key.client_name ?? key.name ?? "", KEY_NAME_MAX);
    return name ? `the agent "${name}"` : "an agent";
  }
  const name = cleanUntrustedName(key.name ?? "", KEY_NAME_MAX);
  const prefix = cleanUntrustedName(key.key_prefix ?? "", 16);
  const named = name ? `the API key "${name}"` : "an API key";
  return prefix ? `${named} (${prefix}...)` : named;
}

/** Where the owner manages this account's billing, on the site they last signed in on. */
export function billingPageUrl(homeSite: string | null, teamId: string | null): string {
  const origin = homeOrigin(homeSite);
  return teamId ? `${origin}/teams/${teamId}` : `${origin}/account/plan`;
}

/**
 * The owner's address, or null when the account has none. A failed read
 * throws: a notice whose owner could not be read is tried again, never
 * taken out of the queue as having nobody to go to.
 */
async function ownerEmail(
  userId: string
): Promise<{ email: string; homeSite: string | null } | null> {
  const { data, error } = await createAdminClient()
    .from("users")
    .select("email, home_site")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.email ? { email: data.email, homeSite: data.home_site ?? null } : null;
}

async function teamName(teamId: string | null): Promise<string | null> {
  if (!teamId) return null;
  const { data } = await createAdminClient()
    .from("teams")
    .select("name")
    .eq("id", teamId)
    .maybeSingle();
  return data?.name ? cleanUntrustedName(data.name, KEY_NAME_MAX) || null : null;
}

/**
 * A team's owner (its owner membership, else its creator), whom a team
 * spend's email goes to; null only when the reads found none (a failed read
 * throws, as ownerEmail's does).
 */
async function teamOwnerOf(teamId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data: owner, error: ownerError } = await admin
    .from("team_members")
    .select("user_id")
    .eq("team_id", teamId)
    .eq("role", "owner")
    .maybeSingle();
  if (ownerError) throw ownerError;
  if (owner?.user_id) return owner.user_id;
  const { data: team, error: teamError } = await admin
    .from("teams")
    .select("created_by")
    .eq("id", teamId)
    .maybeSingle();
  if (teamError) throw teamError;
  return team?.created_by ?? null;
}

type SpendEmailKind = "spent" | "unknown";

/**
 * Tells the owner of a spend's account about it; never throws (the poller
 * sends it again). True only when this call sent it.
 */
async function tellOwner(id: string, kind: SpendEmailKind): Promise<boolean> {
  try {
    return await emailSpend(id, kind);
  } catch (error) {
    reportError("[agent-budget] the spend email was not sent", error, { kind });
    return false;
  }
}

type EmailResult = "sent" | "undeliverable" | "failed";

/**
 * Emails sent whose send could not be recorded (finish failed every try),
 * by spend id or reduction claim: the poller records them again before it
 * sends anything, and never sends them again from this process. Another
 * process may send one again once its claim is five minutes old, so a
 * database that stays unreachable after the send can still mean a second
 * email; a missed one is worse.
 */
const unrecordedSends = new Map<string, () => Promise<void>>();

/** Records how a send ended, a few times over, since a send that went out must not go out again. */
async function recordSend(key: string, record: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await record();
      unrecordedSends.delete(key);
      return;
    } catch (error) {
      if (attempt === 2) {
        unrecordedSends.set(key, record);
        reportError("[agent-budget] could not record an email", error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

/**
 * Sends one of a spend's emails, once: "spent" (the change was made) or
 * "unknown" (it may have been). The claim (claim_agent_budget_email) keeps
 * the request, a webhook and the poller from sending it twice. A send that
 * fails drops the claim and puts the next try off (a backoff by the tries
 * so far); a spend with nobody to tell leaves the queue; a sent email is
 * recorded before anything else, again if need be. Returns whether this
 * call sent it.
 */
export async function emailSpend(id: string, kind: SpendEmailKind): Promise<boolean> {
  const admin = createAdminClient();
  if (unrecordedSends.has(id)) return false;
  const { data: claimed, error: claimError } = await admin.rpc("claim_agent_budget_email", {
    p_id: id,
    p_kind: kind,
  });
  if (claimError) throw claimError;
  if (!claimed) return false;
  let result: EmailResult = "failed";
  try {
    result = await sendSpendEmail(id, kind);
  } finally {
    const finished = result;
    await recordSend(id, async () => {
      const { error } = await admin.rpc("finish_agent_budget_email", {
        p_id: id,
        p_kind: kind,
        p_result: finished,
      });
      if (error) throw error;
    });
  }
  return result === "sent";
}

async function sendSpendEmail(id: string, kind: SpendEmailKind): Promise<EmailResult> {
  const { data: row, error } = await createAdminClient()
    .from("agent_budget_spends")
    .select("user_id, team_id, key_id, agent_registration_id, description, amount_cents, facts")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!row) return "undeliverable";
  const ownerId = row.team_id ? await teamOwnerOf(row.team_id) : row.user_id;
  if (!ownerId) return "undeliverable";
  const owner = await ownerEmail(ownerId);
  if (!owner) return "undeliverable";
  const account: BudgetAccount = { userId: ownerId, teamId: row.team_id };
  const facts = (row.facts ?? {}) as Record<string, unknown>;
  const budget = await getAgentBudget(account);
  const common = {
    to: owner.email,
    change: row.description,
    chargedCents: Number(facts.chargeCents ?? row.amount_cents),
    approximate: facts.approximate === true,
    renewalCents: typeof facts.renewalCents === "number" ? facts.renewalCents : null,
    renewalRiseCents: Number(facts.renewalRiseCents ?? 0),
    annual: facts.annual === true,
    ...(typeof facts.riseCounted === "boolean" ? { riseCounted: facts.riseCounted } : {}),
    countedCents: row.amount_cents,
    key: await keyLabel(row.key_id, row.agent_registration_id),
    leftCents: budget?.leftCents ?? 0,
    budgetCents: budget?.budgetCents ?? 0,
    teamName: await teamName(row.team_id),
    billingUrl: billingPageUrl(owner.homeSite, row.team_id),
  };
  await sendEmail(
    kind === "spent" ? buildAgentBudgetSpentEmail(common) : buildAgentBudgetUnknownEmail(common)
  );
  return "sent";
}

interface Reduction {
  keyId: string | null;
  agentRegistrationId: string | null;
  change: string;
  renewalCents: number | null;
  madeAt: string;
}

/**
 * Sends the account's next reduction notice when one may go
 * (claim_agent_budget_reduction_notice: at most one an hour, with every
 * reduction since the last). "wait" and "none" send nothing; a failed send
 * is tried again by the poller after the backoff.
 */
export async function sendReductionNotice(
  account: BudgetAccount
): Promise<EmailResult | "wait" | "none"> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(
    "claim_agent_budget_reduction_notice",
    accountArgs(account)
  );
  if (error) throw error;
  const claim = (data ?? {}) as Record<string, unknown>;
  if (claim.status === "wait") return "wait";
  if (claim.status !== "claimed" || typeof claim.claim !== "string") return "none";
  const claimId = claim.claim;
  if (unrecordedSends.has(claimId)) return "wait";
  const rows = Array.isArray(claim.reductions)
    ? (claim.reductions as Record<string, unknown>[])
    : [];
  const reductions: Reduction[] = rows.map((row) => ({
    keyId: typeof row.key_id === "string" ? row.key_id : null,
    agentRegistrationId:
      typeof row.agent_registration_id === "string" ? row.agent_registration_id : null,
    change: String(row.description ?? ""),
    renewalCents: typeof row.renewal_cents === "number" ? row.renewal_cents : null,
    madeAt: String(row.made_at ?? ""),
  }));
  let result: EmailResult = "failed";
  try {
    result = await sendReductionEmail(account, reductions);
  } finally {
    const finished = result;
    await recordSend(claimId, async () => {
      const { error: finishError } = await admin.rpc("finish_agent_budget_reduction_notice", {
        p_claim: claimId,
        p_result: finished,
      });
      if (finishError) throw finishError;
    });
  }
  return result;
}

async function sendReductionEmail(
  account: BudgetAccount,
  reductions: Reduction[]
): Promise<EmailResult> {
  if (reductions.length === 0) return "undeliverable";
  const ownerId = account.teamId ? await teamOwnerOf(account.teamId) : account.userId;
  if (!ownerId) return "undeliverable";
  const owner = await ownerEmail(ownerId);
  if (!owner) return "undeliverable";
  const labels = new Map<string, string>();
  const labelKey = (reduction: Reduction) =>
    `${reduction.keyId ?? ""}/${reduction.agentRegistrationId ?? ""}`;
  for (const reduction of reductions) {
    if (!labels.has(labelKey(reduction))) {
      labels.set(
        labelKey(reduction),
        await keyLabel(reduction.keyId, reduction.agentRegistrationId)
      );
    }
  }
  await sendEmail(
    buildAgentBudgetDecreaseEmail({
      to: owner.email,
      reductions: reductions.map((reduction) => ({
        change: reduction.change,
        renewalCents: reduction.renewalCents,
        key: labels.get(labelKey(reduction)) ?? "an API key",
        madeAt: reduction.madeAt,
      })),
      teamName: await teamName(account.teamId),
      billingUrl: billingPageUrl(owner.homeSite, account.teamId),
    })
  );
  return "sent";
}

/** Tells the owner a budget was set or raised; the caller reports a failure. */
export async function emailBudgetSet(
  account: BudgetAccount,
  previousCents: number,
  budgetCents: number,
  by: string
): Promise<void> {
  const owner = await ownerEmail(account.userId);
  if (!owner) return;
  await sendEmail(
    buildAgentBudgetSetEmail({
      to: owner.email,
      previousCents,
      budgetCents,
      teamName: await teamName(account.teamId),
      by,
      billingUrl: billingPageUrl(owner.homeSite, account.teamId),
    })
  );
}

// ---------------------------------------------------------------------------
// The owner's emails, sent again
// ---------------------------------------------------------------------------

const EMAIL_POLL_MS = 2 * 60_000;
const EMAIL_POLL_BATCH = 25;

/**
 * Sends the emails owners have not had, oldest due first
 * (pending_agent_budget_emails): "spent" for a spend made (whatever made
 * it: the request, a webhook, an order), "unknown" for one whose outcome is
 * not known or whose run died; then every reduction notice whose hour is
 * up. A send that fails waits its backoff, and one with nobody to send it
 * to leaves the queue, so neither holds the others back. What was sent is
 * never sent again (the claims), and a send this process could not record
 * is recorded first.
 */
export async function sendPendingAgentBudgetEmails(): Promise<{ sent: number; failed: number }> {
  for (const [key, record] of [...unrecordedSends]) await recordSend(key, record);
  const admin = createAdminClient();
  let sent = 0;
  let failed = 0;
  const { data, error } = await admin.rpc("pending_agent_budget_emails", {
    p_limit: EMAIL_POLL_BATCH,
  });
  if (error) throw error;
  for (const row of data ?? []) {
    const kind: SpendEmailKind = row.kind === "spent" ? "spent" : "unknown";
    try {
      if (await emailSpend(row.spend_id, kind)) sent++;
    } catch (sendError) {
      failed++;
      reportError("[agent-budget] a spend email failed again", sendError, { kind });
    }
  }
  const { data: accounts, error: accountsError } = await admin.rpc(
    "pending_agent_budget_reduction_notices",
    { p_limit: EMAIL_POLL_BATCH }
  );
  if (accountsError) throw accountsError;
  for (const row of accounts ?? []) {
    // A team's notice goes to its owner, whom sendReductionNotice reads
    // from the team, so the account needs no user here.
    const account: BudgetAccount | null = row.team_id
      ? { userId: "", teamId: row.team_id }
      : row.user_id
        ? { userId: row.user_id, teamId: null }
        : null;
    if (!account) continue;
    try {
      const result = await sendReductionNotice(account);
      if (result === "sent") sent++;
      if (result === "failed") failed++;
    } catch (sendError) {
      failed++;
      reportError("[agent-budget] a reduction notice failed again", sendError);
    }
  }
  return { sent, failed };
}

const globalForPoller = globalThis as unknown as {
  __agentBudgetEmailPoller?: ReturnType<typeof setInterval>;
};

/** Starts the poller that sends spend emails that failed or were never sent (instrumentation.ts). */
export function startAgentBudgetEmailPoller(): void {
  if (globalForPoller.__agentBudgetEmailPoller) return;
  const tick = async () => {
    try {
      const { sent, failed } = await sendPendingAgentBudgetEmails();
      if (sent || failed) console.info(`[agent-budget] emails sent=${sent} failed=${failed}`);
    } catch (error) {
      reportError("[agent-budget] the email poll failed", error);
    }
  };
  globalForPoller.__agentBudgetEmailPoller = setInterval(tick, EMAIL_POLL_MS);
  globalForPoller.__agentBudgetEmailPoller.unref();
}

// ---------------------------------------------------------------------------
// Settling from Polar, and turning budgets off
// ---------------------------------------------------------------------------

/**
 * Settles agent budget spends from a plan or team subscription's webhook:
 * a subscription that shows a spend's target marks it made, and a paid
 * order Polar raised for a subscription change counts its spend at the
 * order's before-tax amount (net_amount) when that is more than the quote.
 * A spend settled here that its owner was never told of is emailed.
 *
 * A subscription event never throws: the plan's own handling of it has
 * run, and the next event of the subscription settles the same spends. A
 * paid order throws when it cannot be counted, so the webhook answers 5xx
 * and Polar delivers it again: nothing else would ever count that charge,
 * and the raise is keyed by the order's id (raise_agent_budget_from_order),
 * so a redelivery never counts it twice. The plan handlers do nothing for
 * an order, so the redelivery repeats nothing else.
 */
export async function settleAgentBudgetFromWebhook(
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  if (eventType.startsWith("subscription.")) {
    try {
      await settleFromSubscriptionEvent(eventType, data);
    } catch (error) {
      reportError("[agent-budget] settling a spend from a Polar event failed", error, {
        eventType,
      });
    }
    return;
  }
  await raiseFromOrderEvent(eventType, data);
}

async function settleFromSubscriptionEvent(
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  const subscriptionId = typeof data.id === "string" ? data.id : null;
  if (!subscriptionId) return;
  const { data: settled, error } = await createAdminClient().rpc(
    "settle_agent_budget_from_subscription",
    {
      p_subscription_id: subscriptionId,
      p_seats: typeof data.seats === "number" ? data.seats : null,
      p_product_id: typeof data.product_id === "string" ? data.product_id : null,
    }
  );
  if (error) throw error;
  const ids = Array.isArray(settled) ? settled.map(String) : [];
  if (ids.length > 0) {
    await auditSystemEvent({
      action: "billing.agent_budget_settled",
      outcome: "ok",
      targetId: subscriptionId,
      metadata: { spends: ids.length, eventType },
    });
  }
  for (const id of ids) await tellOwner(id, "spent");
}

/** A paid order for a subscription change: counts its spend at what Polar charged. Throws. */
async function raiseFromOrderEvent(
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  // Only a paid order says Polar charged: a draft or pending one may never be.
  if (eventType !== "order.paid" || data.status !== "paid") return;
  if (data.billing_reason !== "subscription_update") return;
  const subscriptionId = typeof data.subscription_id === "string" ? data.subscription_id : null;
  const orderId = typeof data.id === "string" ? data.id : null;
  const net = typeof data.net_amount === "number" ? data.net_amount : null;
  const createdAt = typeof data.created_at === "string" ? data.created_at : null;
  // Polar's order has no paid time of its own: a payment the bank had
  // confirmed later moves the order (modified_at) when it is paid.
  const paidAt = typeof data.modified_at === "string" ? data.modified_at : createdAt;
  if (!subscriptionId || !orderId || net === null || !createdAt) return;
  const { data: raised, error } = await createAdminClient().rpc("raise_agent_budget_from_order", {
    p_subscription_id: subscriptionId,
    p_order_id: orderId,
    p_net_cents: net,
    p_ordered_at: createdAt,
    p_product_id: typeof data.product_id === "string" ? data.product_id : null,
    p_seats: orderSeats(data),
    p_paid_at: paidAt,
  });
  if (error) throw error;
  const row = raised as Record<string, unknown> | null;
  if (!row) return;
  if (Number(row.after) > Number(row.before)) {
    await auditSystemEvent({
      action: "billing.agent_budget_raised",
      outcome: "ok",
      userId: typeof row.user_id === "string" ? row.user_id : null,
      teamId: typeof row.team_id === "string" ? row.team_id : null,
      targetId: String(row.id),
      metadata: { orderId, beforeCents: row.before, afterCents: row.after },
    });
  }
  if (row.made === true) await tellOwner(String(row.id), "spent");
}

/**
 * The seats a paid order bought: the order's own seats, or, when Polar
 * leaves them out (Order.seats is null on many seat orders), the seats of
 * the subscription the order carries.
 */
export function orderSeats(data: Record<string, unknown>): number | null {
  if (typeof data.seats === "number") return data.seats;
  const subscription = data.subscription as Record<string, unknown> | null | undefined;
  return subscription && typeof subscription.seats === "number" ? subscription.seats : null;
}

/**
 * Turns off every budget the person controls (their own and every team they
 * own or created), and refuses every raise still waiting for their
 * approval: their second factor was removed by a recovery code or by staff,
 * so whoever signs in next may not be them. Throws, so the removal waits
 * for it.
 */
export async function zeroAgentBudgetsForUser(
  userId: string,
  reason: "recovery_code" | "support"
): Promise<void> {
  const { data, error } = await createAdminClient().rpc("zero_agent_budgets_for_user", {
    p_user_id: userId,
  });
  if (error) throw error;
  const result = (data ?? {}) as { user?: boolean; teams?: string[] };
  if (result.user) {
    await auditSystemEvent({
      action: "billing.agent_budget_zeroed",
      outcome: "ok",
      userId,
      metadata: { reason },
    });
  }
  for (const teamId of result.teams ?? []) {
    await auditSystemEvent({
      action: "billing.agent_budget_zeroed",
      outcome: "ok",
      userId,
      teamId,
      metadata: { reason },
    });
  }
}
