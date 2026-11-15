import {
  BLOCK_PAGES,
  BLOCK_REQUESTS,
  DEFAULT_OVERAGE_MAX_REQUESTS,
  DEFAULT_PAGE_OVERAGE_MAX_PAGES,
  MONTHLY_BLOCK_CENTS,
  MONTHLY_DOMAIN_CENTS,
  MONTHLY_PAGE_BLOCK_CENTS,
  ONE_TIME_BLOCK_CENTS,
  ONE_TIME_PAGE_BLOCK_CENTS,
  overageCents,
  PAGE_OVERAGE_CENTS,
} from "@/lib/capacity";
import {
  applyCapacityAction,
  parseCapacityAction,
  type CapacityAction,
} from "@/lib/capacity-route";
import type { Json } from "@/lib/supabase/database";
import type { AuditAction } from "@/lib/audit";
import {
  BillingActionError,
  cancelSubscriptionForUser,
  changePlanForUser,
  getBillingUser,
  keepCurrentPlanForUser,
  loadPlanQuoteForUser,
  resubscribeForUser,
} from "@/lib/supabase/billing";
import {
  assertCanManage,
  CapacityError,
  getCapacityState,
  type CapacityAccount,
  type CapacityState,
} from "@/lib/supabase/capacity-billing";
import {
  cancelTeamSubscription,
  changeTeamPlan,
  getTeamForOwner,
  keepTeamPlan,
  loadTeamPlanQuote,
  loadTeamSeatQuote,
  resubscribeTeam,
  TeamBillingError,
  updateTeamSeats,
  type SeatDirection,
} from "@/lib/supabase/team-billing";
import { reportError } from "@/lib/observability";
import { createPolarClient, loggablePolarError } from "@/lib/polar";
import { POLAR_CALL_MS, withPolarMutationGuard, type PolarMutationGuard } from "./polar-guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { withSupabaseCallTimeout } from "@/lib/supabase/call-timeout";
import { formatCents, teamPlanLabel } from "@/lib/team-pricing";
import { isUuid } from "@/lib/uuid";
import { cleanUntrustedName } from "@/lib/untrusted-name";

/**
 * A billing change an API key or agent token asks for, which the account's
 * owner approves (the `billing.change` approval): what the session-only
 * billing routes do, for the account itself (`teamId` null) or a team it
 * owns. Asking quotes it; approving quotes it again from a fresh read and
 * makes it only when nothing but the clock moved (`runBillingChange`).
 * Checkouts for a first plan and the billing portal stay with a session.
 */
export type BillingChange =
  | { kind: "plan"; plan: "pro" | "business" | "team" | "team_business"; interval: Interval }
  | { kind: "keep_plan" }
  | { kind: "seats"; seats: number }
  | { kind: "cancel" }
  | { kind: "resubscribe" }
  | { kind: "capacity"; capacity: CapacityAction };

type Interval = "month" | "year";

export interface BillingChangeRequest {
  teamId: string | null;
  change: BillingChange;
}

/**
 * A change priced as Polar bills it, kept on the approval. Amounts are in
 * cents, Polar's prices (VAT included where it applies, as the dashboard
 * says). `basis` is the subscription state the quote was made from.
 */
export interface BillingQuote {
  quotedAt: string;
  /** One sentence: what changes. */
  change: string;
  /** "now": made at once; "renewal": from the period end; "checkout": paid at a checkout the owner is sent to. */
  applies: "now" | "renewal" | "checkout";
  /** When it takes effect: the quote's time for "now" and "checkout", the period end for "renewal". */
  effectiveAt: string | null;
  /** What the card is charged on approval (at most this, or about it for a plan switch), or at the checkout. */
  dueNowCents: number;
  /** About, for a plan switch prorated to the second; exact otherwise. */
  approximate: boolean;
  /** What it renews at from then on, when it renews. */
  renewalCents: number | null;
  /** When it next renews at `renewalCents`, when that is known. */
  renewsAt?: string | null;
  /**
   * For overage: the most a period's overage can be billed, at the end of
   * each period. Nothing is charged on approval.
   */
  maxPeriodCents?: number;
  /** Further facts, in plain words. */
  notes: string[];
  basis: Record<string, Json>;
}

/** A refusal the asker or the owner reads, with the status the route would answer. */
export class BillingChangeRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "BillingChangeRefusal";
  }
}

const PERSONAL_STATUS: Record<string, number> = {
  no_subscription: 409,
  plan_ending: 409,
  not_offered: 400,
  unchanged: 409,
  not_scheduled: 409,
  user_not_found: 404,
  payment_failed: 402,
  payment_action_required: 402,
  quote_changed: 409,
};

const TEAM_STATUS: Record<string, number> = {
  not_owner: 403,
  team_not_found: 404,
  owner_not_found: 409,
  invalid_seats: 400,
  no_subscription: 409,
  not_scheduled: 409,
  seats_below_members: 409,
  payment_failed: 402,
  not_offered: 404,
  unchanged: 409,
  plan_ending: 409,
  change_pending: 409,
  seats_below_minimum: 409,
  quote_changed: 409,
  payment_action_required: 402,
};

/**
 * Our own refusals while asking or quoting again, when nothing has been
 * changed yet, as one error; null for anything else.
 */
export function refusalOf(error: unknown): BillingChangeRefusal | null {
  if (error instanceof BillingChangeRefusal) return error;
  if (error instanceof BillingActionError) {
    return new BillingChangeRefusal(PERSONAL_STATUS[error.code] ?? 400, error.message, error.code);
  }
  if (error instanceof TeamBillingError) {
    return new BillingChangeRefusal(TEAM_STATUS[error.code] ?? 400, error.message, error.code);
  }
  if (error instanceof CapacityError) {
    return new BillingChangeRefusal(error.status, error.message, error.code);
  }
  return null;
}

/**
 * The codes the change functions raise only before they ask Polar for
 * anything, or for a charge Polar declined (`payment_failed`), which changes
 * nothing either. Every other error from making a change may come after
 * Polar acted (`seat_update_failed` is raised once Polar accepted and
 * invoiced an increase), so it is never read as "nothing was changed".
 */
const BEFORE_POLAR = {
  personal: new Set([
    "user_not_found",
    "no_subscription",
    "plan_ending",
    "not_offered",
    "unchanged",
    "not_scheduled",
    "payment_failed",
    "quote_changed",
  ]),
  team: new Set([
    "not_owner",
    "team_not_found",
    "owner_not_found",
    "invalid_seats",
    "no_subscription",
    "not_scheduled",
    "seats_below_members",
    "payment_failed",
    "not_offered",
    "unchanged",
    "plan_ending",
    "change_pending",
    "seats_below_minimum",
    "quote_changed",
  ]),
  capacity: new Set([
    "not_found",
    "forbidden",
    "plan_required",
    "plan_ending",
    "not_offered",
    "past_due",
    "invalid_max",
  ]),
};

/** A refusal raised while making the change that certainly changed nothing; null otherwise. */
export function changeRefusalOf(error: unknown): BillingChangeRefusal | null {
  if (error instanceof BillingChangeRefusal) return error;
  const known =
    (error instanceof BillingActionError && BEFORE_POLAR.personal.has(error.code)) ||
    (error instanceof TeamBillingError && BEFORE_POLAR.team.has(error.code)) ||
    (error instanceof CapacityError && BEFORE_POLAR.capacity.has(error.code));
  return known ? refusalOf(error) : null;
}

/**
 * Nothing was touched and the approval may be approved again: billing could
 * not be read for the fresh quote, or another change for the account is
 * running. The approval goes back to pending (an ActionError there).
 */
export class BillingChangeRetry extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "BillingChangeRetry";
  }
}

/** The change an approval carries, checked again (it is stored, then read back). */
export function parseBillingChangeRequest(input: unknown): BillingChangeRequest | null {
  const body = (input ?? {}) as Record<string, unknown>;
  const teamId = body.teamId ?? null;
  if (teamId !== null && (typeof teamId !== "string" || !isUuid(teamId))) return null;
  const change = (body.change ?? {}) as Record<string, unknown>;
  const team = teamId !== null;
  switch (change.kind) {
    case "plan": {
      const interval = change.interval ?? "month";
      if (interval !== "month" && interval !== "year") return null;
      const plans = team ? ["team", "team_business"] : ["pro", "business"];
      if (typeof change.plan !== "string" || !plans.includes(change.plan)) return null;
      return {
        teamId: teamId as string | null,
        change: { kind: "plan", plan: change.plan as "pro", interval },
      };
    }
    case "seats":
      if (!team || typeof change.seats !== "number" || !Number.isInteger(change.seats)) {
        return null;
      }
      return { teamId: teamId as string, change: { kind: "seats", seats: change.seats } };
    case "keep_plan":
    case "cancel":
    case "resubscribe":
      return { teamId: teamId as string | null, change: { kind: change.kind } };
    case "capacity": {
      const capacity = parseCapacityAction(change.capacity);
      return capacity
        ? { teamId: teamId as string | null, change: { kind: "capacity", capacity } }
        : null;
    }
    default:
      return null;
  }
}

/** A quote's inputs, read once, priced at any moment. */
export interface LoadedQuote {
  /** The team's name as the owner's page shows it (cleanTeamName), null for the account itself. */
  teamName: string | null;
  at(nowMs: number): BillingQuote;
  /**
   * What an agent spend budget counts a change at (lib/billing/agent-budget.ts),
   * for the changes it may pay: a plan switch and a seat change. Kept out
   * of the quote itself, which an approval compares whole.
   */
  budget?(nowMs: number): BudgetFacts;
}

/** A change's cost to an agent spend budget, beside its quote. All amounts in cents. */
export interface BudgetFacts {
  /** Account credit Polar spends before the card: the charge before it is dueNowCents plus this. */
  creditAppliedCents: number;
  /**
   * What the next renewal costs without the change: the lower of today's
   * price and a reduction already scheduled for the renewal, so the rise
   * is never undercounted.
   */
  renewalBeforeCents: number;
  /** What the next renewal costs with the change. */
  renewalAfterCents: number;
  /**
   * Whether the subscription renews yearly after the change. A monthly
   * renewal falls inside the budget's 30 days, so its rise counts on top of
   * the charge now; a yearly one does not, and the change counts at the
   * larger of the two (a seat at the full year's price).
   */
  annual: boolean;
  /**
   * What Polar bills the subscription in, lower case ("" when it names
   * none): the budget is in US dollars. Kept here rather than in the
   * quote's basis, which an approval asked before it was read compares.
   */
  currency: string;
}

/**
 * A team's name for the owner's page. The asker controls it (a key may
 * rename a team without an approval), so it is only ever shown as the name
 * in the Account row, never inside the sentence that says what changes,
 * and cleaned like every name someone else chose (cleanUntrustedName) so it
 * cannot read as part of that sentence.
 */
export function cleanTeamName(name: string): string {
  return cleanUntrustedName(name, 80) || "(no name)";
}

/**
 * What identifies a team to its owner beyond its name, which the asker can
 * change: facts a key cannot set (when it was made, how many members it
 * has, its plan and seats), and how many teams the owner owns under the
 * same name.
 */
export interface TeamIdentity {
  name: string;
  createdAt: string;
  members: number;
  plan: string | null;
  seats: number;
  /** Teams the owner owns whose name reads the same, this one included. */
  sameName: number;
}

/** The Account row for a team: its cleaned name and the facts the asker cannot set. */
export function teamAccountLine(identity: TeamIdentity): string {
  const created = new Date(identity.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const members = `${identity.members} ${identity.members === 1 ? "member" : "members"}`;
  const seats = `${identity.seats} ${identity.seats === 1 ? "seat" : "seats"}`;
  const plan = identity.plan ? `on ${identity.plan} with ${seats}` : "with no subscription";
  const line = `A team you own, named ${identity.name}: created ${created}, ${members}, ${plan}.`;
  return identity.sameName > 1
    ? `${line} You own ${identity.sameName} teams with this name, so check these facts against the team you mean.`
    : line;
}

/** Comparing names as the owner reads them: cleaned, ignoring case. */
function nameKey(name: string): string {
  return cleanTeamName(name).toLocaleLowerCase("en-US");
}

/** Reads a team's identity for its owner's page, null when it is gone or no longer theirs. */
export async function loadTeamIdentity(
  userId: string,
  teamId: string
): Promise<TeamIdentity | null> {
  const admin = createAdminClient();
  const [team, members, owned] = await Promise.all([
    admin
      .from("teams")
      .select("id, name, created_at, seats, business, billing_interval, subscription_status")
      .eq("id", teamId)
      .maybeSingle(),
    admin
      .from("team_members")
      .select("user_id", { count: "exact", head: true })
      .eq("team_id", teamId),
    admin.from("team_members").select("team_id").eq("user_id", userId).eq("role", "owner"),
  ]);
  if (team.error) throw team.error;
  if (members.error) throw members.error;
  if (owned.error) throw owned.error;
  const ownedIds = (owned.data ?? []).map((row) => row.team_id);
  if (!team.data || !ownedIds.includes(teamId)) return null;
  const { data: names, error } = await admin.from("teams").select("name").in("id", ownedIds);
  if (error) throw error;
  const key = nameKey(team.data.name);
  const interval = team.data.billing_interval === "year" ? "year" : "month";
  return {
    name: cleanTeamName(team.data.name),
    createdAt: team.data.created_at,
    members: members.count ?? 0,
    plan:
      team.data.subscription_status === null
        ? null
        : teamPlanLabel(team.data.business ? "team_business" : "team", interval),
    seats: team.data.seats,
    sameName: Math.max(1, (names ?? []).filter((row) => nameKey(row.name) === key).length),
  };
}

function planName(plan: string, interval: Interval): string {
  if (plan === "team" || plan === "team_business") return teamPlanLabel(plan, interval);
  const name = plan === "business" ? "Business" : plan === "pro" ? "Pro" : plan;
  return interval === "year" ? `${name} (annual)` : `${name} (monthly)`;
}

/** Who a capacity change is for, and what else its quote needs. */
export interface CapacityContext {
  team: boolean;
  /** The account's verified domains in the order they were verified (extra domains only). */
  verifiedDomains?: string[];
}

/**
 * Reads what a change would do and cost, refusing (BillingChangeRefusal, or
 * the billing modules' own errors) what the dashboard would refuse. `userId`
 * is the account, or the team's owner.
 */
export async function loadBillingQuote(
  userId: string,
  request: BillingChangeRequest
): Promise<LoadedQuote> {
  const { teamId, change } = request;
  if (change.kind === "capacity") {
    const account: CapacityAccount = teamId ? { kind: "team", teamId } : { kind: "user", userId };
    await assertCanManage(account, userId);
    const teamName = teamId ? cleanTeamName((await getTeamForOwner(userId, teamId)).name) : null;
    const resource = change.capacity.resource ?? "requests";
    const [state, verifiedDomains] = await Promise.all([
      getCapacityState(account, resource),
      resource === "domains" ? verifiedDomainsOf(account) : Promise.resolve(undefined),
    ]);
    const context: CapacityContext = { team: teamId !== null, verifiedDomains };
    return { teamName, at: (nowMs) => capacityQuote(change.capacity, state, nowMs, context) };
  }
  return teamId ? loadTeamQuote(userId, teamId, change) : loadPersonalQuote(userId, change);
}

/** Verified domains in the order inbound_domains_allowed() counts them (00072). */
async function verifiedDomainsOf(account: CapacityAccount): Promise<string[]> {
  let query = createAdminClient()
    .from("inbound_domains")
    .select("domain, verified_at, id")
    .eq("status", "verified")
    .order("verified_at", { ascending: true })
    .order("id", { ascending: true });
  query =
    account.kind === "team"
      ? query.eq("team_id", account.teamId)
      : query.eq("user_id", account.userId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => row.domain);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function longDay(isoTime: string | null | undefined): string {
  if (!isoTime) return "the end of the period";
  return new Date(isoTime).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * What a subscription renews at and when, from Polar's live state: the
 * quote of keeping, resuming or cancelling a plan shows it, and compares
 * it on approval like the rest of its basis.
 */
interface SubscriptionFacts {
  status: string;
  cancelAtPeriodEnd: boolean;
  amountCents: number;
  seats: number | null;
  periodEnd: string;
  pendingProduct: string | null;
  pendingSeats: number | null;
}

async function subscriptionFacts(subscriptionId: string): Promise<SubscriptionFacts> {
  const subscription = await createPolarClient().subscriptions.get(subscriptionId);
  return {
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    amountCents: subscription.amount,
    seats: subscription.seats ?? null,
    periodEnd: iso(Date.parse(String(subscription.current_period_end))),
    pendingProduct: subscription.pending_update?.product_id ?? null,
    pendingSeats: subscription.pending_update?.seats ?? null,
  };
}

function factsBasis(facts: SubscriptionFacts): Record<string, Json> {
  return {
    polarStatus: facts.status,
    polarCancelAtPeriodEnd: facts.cancelAtPeriodEnd,
    amount: facts.amountCents,
    polarSeats: facts.seats,
    periodEnd: facts.periodEnd,
    pendingProduct: facts.pendingProduct,
    pendingSeats: facts.pendingSeats,
  };
}

async function loadPersonalQuote(
  userId: string,
  change: Exclude<BillingChange, { kind: "capacity" }>
): Promise<LoadedQuote> {
  if (change.kind === "seats") {
    throw new BillingChangeRefusal(400, "Seats belong to a team: name the team", "invalid_seats");
  }
  if (change.kind === "plan") {
    const loaded = await loadPlanQuoteForUser(
      userId,
      change.plan as "pro" | "business",
      change.interval
    );
    return {
      teamName: null,
      at: (nowMs) => {
        const q = loaded.at(nowMs);
        const from = planName(q.currentPlan, q.currentInterval);
        const to = planName(q.plan, q.interval);
        const now = q.applies === "now";
        return {
          quotedAt: iso(nowMs),
          change: `Change the plan from ${from} to ${to}.`,
          applies: q.applies,
          effectiveAt: now ? iso(nowMs) : q.periodEnd,
          dueNowCents: q.dueNowCents,
          approximate: now,
          renewalCents: q.renewalCents,
          renewsAt: q.periodEnd,
          notes: now
            ? [
                `Charged the difference for the rest of this period: ${formatCents(q.chargeCents)} for ${to}, less ${formatCents(q.creditCents)} unused of ${from}${q.creditAppliedCents > 0 ? ` and ${formatCents(q.creditAppliedCents)} of account credit` : ""}.`,
                "The extra requests and parsed pages for this period come in the same proportion.",
              ]
            : ["Nothing changes until the renewal; until then the current plan stays."],
          basis: loaded.basis,
        };
      },
      budget: (nowMs) => {
        const q = loaded.at(nowMs);
        return {
          creditAppliedCents: q.creditAppliedCents,
          renewalBeforeCents: loaded.currentAmountCents,
          renewalAfterCents: q.renewalCents,
          annual: q.interval === "year",
          currency: loaded.currency,
        };
      },
    };
  }

  const user = await getBillingUser(userId);
  if (!user.polar_subscription_id || user.plan === "free") {
    throw new BillingActionError("no_subscription", "No active subscription");
  }
  const current = planName(user.plan, user.billing_interval === "year" ? "year" : "month");
  if (change.kind === "keep_plan" && !user.pending_plan) {
    throw new BillingActionError("unchanged", "No plan change is waiting");
  }
  if (change.kind === "cancel" && user.cancel_at_period_end) {
    throw new BillingActionError("unchanged", "The plan is already set to end");
  }
  if (change.kind === "resubscribe" && !user.cancel_at_period_end) {
    throw new BillingActionError("not_scheduled", "Subscription is not scheduled for cancellation");
  }
  const facts = await subscriptionFacts(user.polar_subscription_id);
  const basis = {
    subscriptionId: user.polar_subscription_id,
    plan: user.plan,
    interval: user.billing_interval,
    cancelAtPeriodEnd: user.cancel_at_period_end,
    pendingPlan: user.pending_plan,
    ...factsBasis(facts),
  };
  // Keeping the plan drops the waiting change, so it renews at today's
  // price; resuming keeps a waiting change, whose price Polar holds.
  const renewal =
    change.kind === "cancel"
      ? 0
      : change.kind === "resubscribe" && (user.pending_plan || facts.pendingProduct)
        ? null
        : facts.amountCents;
  const sentence =
    change.kind === "keep_plan"
      ? `Keep ${current}: drop the plan change waiting for the renewal.`
      : change.kind === "cancel"
        ? `Cancel ${current} at the end of the period.`
        : `Keep ${current}: undo the cancellation, so it renews.`;
  const notes =
    change.kind === "cancel"
      ? [
          `The plan, monthly blocks and overage stay until ${longDay(facts.periodEnd)}, then end with it.`,
        ]
      : renewal === null
        ? [
            `It renews on ${longDay(facts.periodEnd)} on the plan change waiting for the renewal, at that plan's price.`,
          ]
        : [
            `It renews on ${longDay(facts.periodEnd)} at ${formatCents(renewal)}, then every ${user.billing_interval === "year" ? "year" : "month"}.`,
          ];
  return {
    teamName: null,
    at: (nowMs) => ({
      quotedAt: iso(nowMs),
      change: sentence,
      applies: change.kind === "cancel" ? "renewal" : "now",
      effectiveAt: change.kind === "cancel" ? facts.periodEnd : iso(nowMs),
      dueNowCents: 0,
      approximate: false,
      renewalCents: renewal,
      renewsAt: change.kind === "cancel" ? null : facts.periodEnd,
      notes,
      basis,
    }),
  };
}

async function loadTeamQuote(
  userId: string,
  teamId: string,
  change: Exclude<BillingChange, { kind: "capacity" }>
): Promise<LoadedQuote> {
  if (change.kind === "plan") {
    const loaded = await loadTeamPlanQuote(
      userId,
      teamId,
      change.plan as "team" | "team_business",
      change.interval
    );
    return {
      teamName: cleanTeamName(loaded.team.name),
      at: (nowMs) => {
        const q = loaded.at(nowMs);
        const from = teamPlanLabel(loaded.current.plan, loaded.current.interval);
        const to = teamPlanLabel(q.plan, q.interval);
        const now = q.applies === "now";
        const newYear = q.interval === "year" && loaded.current.interval !== "year";
        return {
          quotedAt: iso(nowMs),
          change: `Change the team from ${from} to ${to} (${q.seats} ${q.seats === 1 ? "seat" : "seats"}).`,
          applies: q.applies,
          effectiveAt: now ? iso(nowMs) : q.periodEnd,
          dueNowCents: q.dueNowCents,
          approximate: now,
          renewalCents: q.renewalCents,
          renewsAt: q.periodEnd,
          notes: now
            ? [
                newYear
                  ? `A new year starts now at ${formatCents(q.chargeCents)}, less ${formatCents(q.creditCents)} unused of this month.`
                  : `Charged ${formatCents(q.chargeCents)} for the rest of this period, less ${formatCents(q.creditCents)} unused of ${from}.`,
                ...(q.creditAppliedCents > 0
                  ? [`${formatCents(q.creditAppliedCents)} of account credit is spent first.`]
                  : []),
              ]
            : ["Nothing changes until the renewal; until then the current plan stays."],
          basis: loaded.basis,
        };
      },
      budget: (nowMs) => {
        const q = loaded.at(nowMs);
        // A seat reduction waiting for the renewal renews lower without the
        // change; count the rise from there.
        const pending = [loaded.basis.pendingSeats, loaded.basis.teamPendingSeats].filter(
          (value): value is number => typeof value === "number" && value > 0 && value < q.seats
        );
        const renewsSeats = pending.length > 0 ? Math.min(...pending) : q.seats;
        return {
          creditAppliedCents: q.creditAppliedCents,
          renewalBeforeCents: Math.floor((loaded.currentAmountCents * renewsSeats) / q.seats),
          renewalAfterCents: q.renewalCents,
          annual: q.interval === "year",
          currency: loaded.currency,
        };
      },
    };
  }
  if (change.kind === "seats") {
    const loaded = await loadTeamSeatQuote(userId, teamId, change.seats);
    if (change.seats === loaded.team.seats && loaded.team.pending_seats === null) {
      throw new TeamBillingError("unchanged", `The team has ${change.seats} seats already`);
    }
    return {
      teamName: cleanTeamName(loaded.team.name),
      at: (nowMs) => {
        const q = loaded.at(nowMs);
        const more = q.newSeats > q.currentSeats;
        return {
          quotedAt: iso(nowMs),
          change:
            q.newSeats === q.currentSeats
              ? sameSeatsSentence(q.currentSeats, q.pendingSeats, loaded.team)
              : `Change the team from ${q.currentSeats} to ${q.newSeats} seats.`,
          applies: more || q.newSeats === q.currentSeats ? "now" : "renewal",
          effectiveAt: q.appliesAtRenewal ? q.periodEnd : iso(nowMs),
          dueNowCents: q.dueNowCents,
          approximate: false,
          renewalCents: q.renewalCents,
          renewsAt: q.periodEnd,
          notes: more
            ? [
                `The added seats cost ${formatCents(q.prorationCents)} for the rest of this period${q.creditAppliedCents > 0 ? `, ${formatCents(q.creditAppliedCents)} of it from account credit` : ""}.`,
              ]
            : q.appliesAtRenewal
              ? ["The current seats stay until the renewal; nothing is credited."]
              : [],
          // The seats and the period the charge is for: the increase checks
          // them again right before Polar is asked (updateTeamSeats).
          // Polar's own scheduled seats too: the budget counts a reduction
          // only below the lower of it and ours (classifyChange).
          basis: {
            ...loaded.basis,
            currentSeats: q.currentSeats,
            pendingSeats: q.pendingSeats,
            periodEnd: q.periodEnd,
          },
        };
      },
      budget: (nowMs) => {
        const q = loaded.at(nowMs);
        const pending = [q.pendingSeats, loaded.team.pending_seats].filter(
          (value): value is number =>
            typeof value === "number" && value > 0 && value < q.currentSeats
        );
        const renewsSeats = pending.length > 0 ? Math.min(...pending) : q.currentSeats;
        return {
          creditAppliedCents: q.creditAppliedCents,
          renewalBeforeCents: renewsSeats * q.pricePerSeatCents,
          renewalAfterCents: q.renewalCents,
          annual: loaded.team.billing_interval === "year",
          currency: loaded.currency,
        };
      },
    };
  }

  const team = await getTeamForOwner(userId, teamId);
  if (!team.polar_subscription_id || team.subscription_status === null) {
    throw new TeamBillingError("no_subscription", "No active subscription");
  }
  const interval = team.billing_interval === "year" ? "year" : "month";
  const current = teamPlanLabel(team.business ? "team_business" : "team", interval);
  if (change.kind === "keep_plan" && !team.pending_plan) {
    throw new TeamBillingError("unchanged", "No plan change is waiting");
  }
  if (change.kind === "cancel" && team.cancel_at_period_end) {
    throw new TeamBillingError("unchanged", "The subscription is already set to end");
  }
  if (change.kind === "resubscribe" && !team.cancel_at_period_end) {
    throw new TeamBillingError("not_scheduled", "Subscription is not scheduled for cancellation");
  }
  const facts = await subscriptionFacts(team.polar_subscription_id);
  const basis = {
    subscriptionId: team.polar_subscription_id,
    status: team.subscription_status,
    business: team.business,
    interval: team.billing_interval,
    seats: team.seats,
    cancelAtPeriodEnd: team.cancel_at_period_end,
    pendingPlan: team.pending_plan,
    teamPendingSeats: team.pending_seats,
    ...factsBasis(facts),
  };
  // What it renews at: keeping the plan drops the waiting plan change and
  // schedules a waiting seat reduction again; resuming keeps whatever
  // waits, which Polar prices only when that is seats alone.
  const seatsNow = facts.seats ?? team.seats;
  const perSeat = seatsNow > 0 ? Math.round(facts.amountCents / seatsNow) : 0;
  const reduction =
    team.pending_seats !== null && team.pending_seats < team.seats ? team.pending_seats : null;
  const renewal =
    change.kind === "cancel"
      ? 0
      : change.kind === "keep_plan"
        ? reduction !== null
          ? perSeat * reduction
          : facts.amountCents
        : team.pending_plan || facts.pendingProduct
          ? null
          : facts.pendingSeats !== null
            ? perSeat * facts.pendingSeats
            : facts.amountCents;
  const renewSeats =
    change.kind === "keep_plan"
      ? (reduction ?? seatsNow)
      : (facts.pendingSeats ?? team.pending_seats ?? seatsNow);
  const sentence =
    change.kind === "keep_plan"
      ? `Keep the team on ${current}: drop the plan change waiting for the renewal.`
      : change.kind === "cancel"
        ? `Cancel the team's ${current} subscription at the end of the period.`
        : `Keep the team's ${current} subscription: undo the cancellation, so it renews.`;
  const notes =
    change.kind === "cancel"
      ? [`Members keep the team's endpoints and pool until ${longDay(facts.periodEnd)}.`]
      : renewal === null
        ? [
            `It renews on ${longDay(facts.periodEnd)} on the plan change waiting for the renewal, at that plan's price.`,
          ]
        : [
            `It renews on ${longDay(facts.periodEnd)} at ${formatCents(renewal)} for ${renewSeats} ${renewSeats === 1 ? "seat" : "seats"}, then every ${interval}.`,
          ];
  return {
    teamName: cleanTeamName(team.name),
    at: (nowMs) => ({
      quotedAt: iso(nowMs),
      change: sentence,
      applies: change.kind === "cancel" ? "renewal" : "now",
      effectiveAt: change.kind === "cancel" ? facts.periodEnd : iso(nowMs),
      dueNowCents: 0,
      approximate: false,
      renewalCents: renewal,
      renewsAt: change.kind === "cancel" ? null : facts.periodEnd,
      notes,
      basis,
    }),
  };
}

function seatWord(n: number): string {
  return `${n} ${n === 1 ? "seat" : "seats"}`;
}

/**
 * The sentence for asking for the seats Polar bills already (`seats`):
 * dropping the reduction Polar has waiting, or, when Polar and this
 * database disagree (a write that failed after Polar acted), setting ours
 * to match Polar's. Exported for its tests.
 */
export function sameSeatsSentence(
  seats: number,
  polarPending: number | null,
  team: { seats: number; pending_seats: number | null }
): string {
  if (polarPending !== null) {
    return `Keep ${seatWord(seats)} on the team: drop the reduction to ${polarPending} waiting for the renewal.`;
  }
  // updateTeamSeats compares with our count: higher than ours is recorded
  // at once, lower is scheduled for the renewal like any reduction.
  if (team.seats < seats) {
    return `Keep ${seatWord(seats)} on the team, the count Polar bills already: this account shows ${team.seats} and is set to ${seats} now. Nothing more is charged.`;
  }
  if (team.seats > seats) {
    return `Keep ${seatWord(seats)} on the team, the count Polar bills already: this account shows ${team.seats} and is set to ${seats} from the renewal. Nothing is charged or credited.`;
  }
  if (team.pending_seats !== null) {
    return `Keep ${seatWord(seats)} on the team: drop the reduction to ${team.pending_seats} this account shows for the renewal, which Polar no longer has.`;
  }
  return `Keep ${seatWord(seats)} on the team.`;
}

/** What one block of a resource is, and costs. */
function blockFacts(resource: "requests" | "pages" | "domains") {
  if (resource === "pages") {
    return {
      monthly: MONTHLY_PAGE_BLOCK_CENTS,
      oneTime: ONE_TIME_PAGE_BLOCK_CENTS,
      size: BLOCK_PAGES,
      defaultOverageMax: DEFAULT_PAGE_OVERAGE_MAX_PAGES,
      overageCents: (pages: number) => pages * PAGE_OVERAGE_CENTS,
      noun: (n: number) => `${(n * BLOCK_PAGES).toLocaleString("en-US")} parsed pages`,
    };
  }
  if (resource === "domains") {
    return {
      monthly: MONTHLY_DOMAIN_CENTS,
      oneTime: 0,
      size: 1,
      defaultOverageMax: 0,
      overageCents: () => 0,
      noun: (n: number) => `${n} extra ${n === 1 ? "domain" : "domains"}`,
    };
  }
  return {
    monthly: MONTHLY_BLOCK_CENTS,
    oneTime: ONE_TIME_BLOCK_CENTS,
    size: BLOCK_REQUESTS,
    defaultOverageMax: DEFAULT_OVERAGE_MAX_REQUESTS,
    overageCents,
    noun: (n: number) => `${(n * BLOCK_REQUESTS).toLocaleString("en-US")} requests`,
  };
}

/**
 * Which verified domains stop receiving mail once the allowance is
 * `allowed`: those past it in the order they were verified, the most
 * recently verified first to go (resolve_inbound_recipient(), 00072).
 */
function domainsPast(allowed: number, verified: string[] | undefined): string | null {
  if (!verified) return null;
  const stopping = verified.slice(Math.max(0, allowed));
  if (stopping.length === 0) {
    return `Every verified domain stays within the new allowance of ${allowed}.`;
  }
  return `At the renewal ${stopping.length === 1 ? "this domain stops" : "these domains stop"} receiving mail (the most recently verified past the new allowance of ${allowed}; ${stopping.length === 1 ? "it stays" : "they stay"} listed): ${stopping.join(", ")}.`;
}

/**
 * A capacity change priced from the dashboard's own prices and the
 * account's add-on state, deciding as changeMonthlyBlocks and setOverage
 * do whether it is a checkout, made now, or from the renewal. `context`
 * says whether it is a team's (the sentence says so; the Account row names
 * the team) and, for extra domains, which domains are verified.
 */
export function capacityQuote(
  action: CapacityAction,
  state: CapacityState,
  nowMs: number,
  context: CapacityContext = { team: false }
): BillingQuote {
  const resource = action.resource ?? "requests";
  const facts = blockFacts(resource);
  const blocks = state.blocks;
  const whose = context.team ? " for the team" : "";
  // What the decision rests on; usage counters are left out, since every
  // capture moves them.
  const basis: Record<string, Json> = {
    eligible: state.eligible,
    planEnding: state.planEnding,
    periodEnd: state.periodEnd,
    blocks: blocks
      ? {
          units: blocks.units,
          pendingUnits: blocks.pendingUnits,
          cancelAtPeriodEnd: blocks.cancelAtPeriodEnd,
          pastDue: blocks.pastDue,
          periodEnd: blocks.periodEnd,
        }
      : null,
    overage: {
      subscribed: state.overage.subscribed,
      cancelAtPeriodEnd: state.overage.cancelAtPeriodEnd,
      pastDue: state.overage.pastDue,
      maxRequests: state.overage.maxRequests,
    },
  };
  const base = {
    quotedAt: iso(nowMs),
    approximate: false,
    basis,
  };
  const now = iso(nowMs);
  // When the monthly blocks renew: their own period, else the plan's.
  const blocksRenewAt = blocks?.periodEnd ?? state.periodEnd;
  const unchanged = (message: string) => new CapacityError("unchanged", message, 409);
  // Ending or lowering what renews needs no live plan; anything that adds does.
  const adds =
    action.action === "buy_blocks" ||
    (action.action === "set_monthly_blocks" && action.blocks > 0) ||
    (action.action === "set_overage" && action.enabled);
  if (adds && !state.offered) {
    throw new CapacityError("not_offered", "That add-on is not available yet", 404);
  }
  if (adds && !state.eligible) {
    throw new CapacityError(
      "plan_required",
      "This add-on needs a plan that offers it, on a live subscription. Change the plan first."
    );
  }
  if (adds && action.action !== "buy_blocks" && state.planEnding) {
    throw new CapacityError(
      "plan_ending",
      "The plan is set to end, and monthly add-ons end with it. Keep the plan first."
    );
  }

  if (action.action === "buy_blocks") {
    return {
      ...base,
      change: `Buy ${facts.noun(action.blocks)} that never expire${whose}.`,
      applies: "checkout",
      effectiveAt: now,
      dueNowCents: action.blocks * facts.oneTime,
      renewalCents: null,
      notes: [
        `Paid at a Polar checkout that approving opens, for exactly ${action.blocks} ${action.blocks === 1 ? "block" : "blocks"}; nothing is bought until it is paid.`,
      ],
    };
  }

  if (action.action === "set_monthly_blocks") {
    const target = action.blocks;
    const monthly = (n: number) => n * facts.monthly;
    const domainNote = (allowedExtra: number) =>
      resource === "domains"
        ? domainsPast(state.planRequests + allowedExtra, context.verifiedDomains)
        : null;
    if (!blocks || (blocks.cancelAtPeriodEnd && target === 0)) {
      if (target === 0) throw unchanged("There are no monthly blocks to end");
    }
    if (blocks?.pastDue && target > 0) {
      throw new CapacityError(
        "past_due",
        "The last payment for the monthly blocks failed. Update the payment method first."
      );
    }
    if (!blocks) {
      return {
        ...base,
        change: `Add ${facts.noun(target)} every period${whose}.`,
        applies: "checkout",
        effectiveAt: now,
        dueNowCents: monthly(target),
        renewalCents: monthly(target),
        renewsAt: state.periodEnd,
        notes: [
          "Paid at a Polar checkout that approving opens, for the rest of this period; they then renew with the plan.",
        ],
      };
    }
    if (target === 0) {
      const note = domainNote(0);
      return {
        ...base,
        change: `End the ${facts.noun(blocks.units)} added every period${whose}.`,
        applies: "renewal",
        effectiveAt: blocksRenewAt,
        dueNowCents: 0,
        renewalCents: 0,
        notes: ["They stay until the period ends and are not renewed.", ...(note ? [note] : [])],
      };
    }
    if (target > blocks.units) {
      return {
        ...base,
        change: `Add ${facts.noun(target - blocks.units)} more every period${whose} (${facts.noun(target)} in all).`,
        applies: "checkout",
        effectiveAt: now,
        dueNowCents: monthly(target - blocks.units),
        renewalCents: monthly(target),
        renewsAt: blocksRenewAt,
        notes: [
          "The added blocks are paid at their full monthly price at a Polar checkout that approving opens.",
        ],
      };
    }
    const renews = blocks.pendingUnits ?? blocks.units;
    if (target === renews && !blocks.cancelAtPeriodEnd) {
      throw unchanged(`The monthly blocks renew at ${facts.noun(target)} already`);
    }
    const note = target < blocks.units ? domainNote(target) : null;
    return {
      ...base,
      change:
        target === blocks.units
          ? `Keep ${facts.noun(target)} every period${whose}${blocks.cancelAtPeriodEnd ? " instead of ending them" : ", dropping the scheduled reduction"}.`
          : `Reduce the monthly blocks${whose} from ${facts.noun(blocks.units)} to ${facts.noun(target)} at the renewal.`,
      applies: "renewal",
      effectiveAt: blocksRenewAt,
      dueNowCents: 0,
      renewalCents: monthly(target),
      renewsAt: blocksRenewAt,
      notes: ["Nothing is charged or credited now.", ...(note ? [note] : [])],
    };
  }

  // Overage.
  const noun = resource === "pages" ? "parsed pages" : "requests";
  if (!action.enabled) {
    if (!state.overage.subscribed || state.overage.cancelAtPeriodEnd) {
      if (state.overage.maxRequests === 0) throw unchanged("Overage is off already");
    }
    return {
      ...base,
      change: `Turn off overage for ${noun}${whose}.`,
      applies: "now",
      effectiveAt: now,
      dueNowCents: 0,
      renewalCents: null,
      notes: ["Counting stops now; what was used this period is billed at its end."],
    };
  }
  // The maximum setOverage stores: the one asked for, else the one kept,
  // else the default.
  const max =
    action.maxBlocks !== undefined
      ? action.maxBlocks * facts.size
      : state.overage.maxRequests > 0
        ? state.overage.maxRequests
        : facts.defaultOverageMax;
  const maxPeriodCents = facts.overageCents(max);
  if (
    state.overage.subscribed &&
    !state.overage.cancelAtPeriodEnd &&
    max === state.overage.maxRequests
  ) {
    throw unchanged(`Overage is on with that maximum already`);
  }
  const on = state.overage.subscribed && !state.overage.cancelAtPeriodEnd;
  return {
    ...base,
    change: `${on ? "Set the overage maximum" : "Turn on overage"} for ${noun}${whose} to at most ${max.toLocaleString("en-US")} ${noun} a period: up to ${formatCents(maxPeriodCents)} per period.`,
    applies: state.overage.subscribed ? "now" : "checkout",
    effectiveAt: now,
    dueNowCents: 0,
    renewalCents: null,
    maxPeriodCents,
    notes: [
      state.overage.subscribed
        ? `Nothing is charged now; what is used past the allowance is billed at the end of each period, up to ${formatCents(maxPeriodCents)}.`
        : `Starts at a Polar checkout that approving opens (nothing is charged there); what is used is billed at the end of each period, up to ${formatCents(maxPeriodCents)}.`,
    ],
  };
}

/** A quote as one canonical string, to compare two. */
export function quoteFingerprint(quote: BillingQuote): string {
  return canonicalJson(quote);
}

/** A value as one canonical JSON string: object keys sorted, undefined left out. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Time alone moves a prorated charge by cents (Polar prices to the second):
 * a fresh quote may come out at most this much above the approved one.
 */
export function chargeCeiling(quotedCents: number): number {
  return quotedCents + Math.max(1, Math.ceil(quotedCents / 100));
}

/**
 * What a billing approval did, kept on the approval for its asker and the
 * owner's page.
 *
 * - `executed: true`: made, at once or from the renewal. `applied:
 *   "checkout"` means only that a checkout was opened for the owner:
 *   nothing is bought until it is paid there.
 * - `executed: false`: nothing was changed, and `reason` says why.
 * - `executed: null`: Polar was asked to make it and then something failed,
 *   so it may or may not have happened (`outcome_unknown`): check billing
 *   before asking again.
 */
export type BillingChangeOutcome =
  | { executed: true; applied: "now" | "renewal"; seatReductionLost?: number }
  | { executed: true; applied: "checkout"; checkout: "opened" }
  | { executed: false; code: string; reason: string }
  | { executed: null; code: "outcome_unknown"; reason: string };

/** An outcome, and the checkout the owner's browser goes on to (never stored). */
export interface BillingChangeRun {
  outcome: BillingChangeOutcome;
  checkoutUrl?: string;
}

const OUTCOME_UNKNOWN =
  "The change may or may not have been made: Polar was asked to make it, and then something failed. Check billing before asking again.";

/**
 * What the asker reads for a billing approval whose run left no result (the
 * process died after it started, maybe after Polar acted): the same as any
 * other outcome that cannot be known.
 */
export const BILLING_OUTCOME_UNKNOWN = {
  executed: null,
  code: "outcome_unknown",
  reason: OUTCOME_UNKNOWN,
} as const satisfies BillingChangeOutcome;

/** How long one account's change holds its lease at a time; each mutating Polar call renews it. */
const LOCK_SECONDS = 120;

/**
 * The most a run may take from the moment it took the lease: no mutating
 * Polar call starts later than POLAR_CALL_MS before it. Each such call
 * renews the lease for LOCK_SECONDS first, which outlasts the call, so a
 * change never reaches Polar on a lease another run could take.
 */
const RUN_DEADLINE_MS = 100_000;

/** A lease renewal slower than this counts as failed: the change stops before Polar. */
const EXTEND_TIMEOUT_MS = 5_000;

/** The most one database call of a run may take (withSupabaseCallTimeout). */
const SUPABASE_CALL_MS = 10_000;

/**
 * How long after an approval starts its run the poll reads it as running
 * though it holds no lease yet: taking the lease is the run's first call,
 * cut off at SUPABASE_CALL_MS.
 */
const LEASE_CLAIM_GRACE_MS = 30_000;

/** The billing account a change is for, as the lease names it. */
function accountKey(userId: string, teamId: string | null): string {
  return teamId ? `team:${teamId}` : `user:${userId}`;
}

/**
 * The lease was lost or ran short after Polar had already been asked to
 * change something in this run: what it did stays unknown.
 */
class LeaseLostMidChange extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseLostMidChange";
  }
}

/**
 * The account's lease, held for one run, checked before each mutating
 * Polar call (the PolarMutationGuard): the run must be inside its deadline
 * and the lease renewed, still held by this run. Until the first mutating
 * call goes out, a failed check is a BillingChangeRetry (nothing was
 * touched); after one, it ends the run as outcome_unknown.
 */
class ChangeLease implements PolarMutationGuard {
  /** Mutating Polar calls let through so far. */
  mutations = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly key: string,
    private readonly holder: string
  ) {}

  async beforeMutation(): Promise<void> {
    if (Date.now() + POLAR_CALL_MS > this.startedAt + RUN_DEADLINE_MS) {
      this.refuse("the change took too long to start");
    }
    if (!(await this.renew())) this.refuse("its lease ran out");
    // The renewal itself may have been slow: the call still needs its time.
    if (Date.now() + POLAR_CALL_MS > this.startedAt + RUN_DEADLINE_MS) {
      this.refuse("the change took too long to start");
    }
    this.mutations += 1;
  }

  /** True when this run still held the lease and now holds it for LOCK_SECONDS more. */
  private async renew(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), EXTEND_TIMEOUT_MS);
    });
    try {
      const renewed = await Promise.race([
        createAdminClient().rpc("extend_billing_change_lock", {
          p_account_key: this.key,
          p_holder: this.holder,
          p_seconds: LOCK_SECONDS,
        }),
        timedOut,
      ]);
      if (renewed === null) return false;
      if (renewed.error) {
        reportError("Renewing the billing change lease failed", renewed.error);
        return false;
      }
      return renewed.data === true;
    } finally {
      clearTimeout(timer);
    }
  }

  private refuse(why: string): never {
    if (this.mutations === 0) {
      throw new BillingChangeRetry(
        503,
        `Nothing was changed: ${why} before billing was asked. Try again in a minute.`
      );
    }
    throw new LeaseLostMidChange(why);
  }
}

export interface BillingChangeRunOptions {
  /**
   * Who holds the lease: an approval's id, so the asker's poll can tell a
   * run still going from one that ended without a result
   * (billingChangeStillRunning). Otherwise a new id.
   */
  holder?: string;
  /**
   * Called with the outcome while the lease is still held: an approval
   * records its result here, so no poll ever finds the lease gone and the
   * result not yet kept. A failure is reported and the run's outcome stands.
   */
  whileHeld?: (run: BillingChangeRun) => Promise<void>;
}

/**
 * Makes an approved change, only if a fresh quote, priced at the moment of
 * the ask, equals the approved one (same plan, prices, seats, period,
 * credit and subscription state) and the charge now is no more than time
 * explains. Otherwise nothing is changed and the outcome says why: the
 * asker asks again. A replay of a change already made finds the state it
 * changed and refuses, so nothing is ever made or charged twice.
 *
 * Changes for one billing account run one at a time (a lease in
 * billing_change_locks), so two approvals approved together cannot both
 * pass against the state before either. The lease is renewed, and must
 * still be this run's, right before each Polar call that changes or
 * charges anything (ChangeLease), and a run that passes its deadline makes
 * no further call. Every database call of the run is cut off after
 * SUPABASE_CALL_MS, so a hung request cannot hold a run past its lease,
 * where the asker's poll would read it as over (billingChangeStillRunning).
 * BillingChangeRetry means nothing was touched (the lease is held or was
 * lost before any change, or billing could not be read), and the approval
 * may be approved again.
 */
export async function runBillingChange(
  userId: string,
  request: BillingChangeRequest,
  approved: BillingQuote,
  options: BillingChangeRunOptions = {}
): Promise<BillingChangeRun> {
  return withBillingChangeLease(
    userId,
    request.teamId,
    (lease) => runLocked(userId, request, approved, lease),
    options
  );
}

/** The account's lease as a run inside withBillingChangeLease sees it. */
export interface BillingChangeLease {
  /** Mutating Polar calls let through so far: 0 means nothing reached Polar. */
  readonly mutations: number;
}

/**
 * Runs `fn` holding the billing account's change lease (billing_change_locks),
 * with every mutating Polar call it makes checked against the lease first
 * (ChangeLease) and every database call cut off after SUPABASE_CALL_MS. One
 * change per account at a time, whether an approval or the agent budget
 * makes it. Throws BillingChangeRetry, before `fn` runs, when the lease is
 * held (409) or cannot be taken (503). `options.whileHeld` gets what `fn`
 * returned before the lease is given back.
 */
export function withBillingChangeLease<T>(
  userId: string,
  teamId: string | null,
  fn: (lease: BillingChangeLease) => Promise<T>,
  options: { holder?: string; whileHeld?: (value: T) => Promise<void> } = {}
): Promise<T> {
  return withSupabaseCallTimeout(SUPABASE_CALL_MS, () => leased(userId, teamId, fn, options));
}

async function leased<T>(
  userId: string,
  teamId: string | null,
  fn: (lease: BillingChangeLease) => Promise<T>,
  options: { holder?: string; whileHeld?: (value: T) => Promise<void> }
): Promise<T> {
  const key = accountKey(userId, teamId);
  const holder = options.holder ?? crypto.randomUUID();
  const admin = createAdminClient();
  const { data: claimed, error: claimError } = await admin.rpc("claim_billing_change_lock", {
    p_account_key: key,
    p_holder: holder,
    p_seconds: LOCK_SECONDS,
  });
  if (claimError) {
    reportError("Taking the billing change lease failed", claimError);
    throw new BillingChangeRetry(
      503,
      "Billing could not be reached just now, so nothing was changed. Try again in a minute."
    );
  }
  if (claimed !== true) {
    throw new BillingChangeRetry(
      409,
      "Another billing change for this account is being made. Nothing was changed; try again in a moment."
    );
  }
  const lease = new ChangeLease(key, holder);
  try {
    const value = await withPolarMutationGuard(lease, () => fn(lease));
    if (options.whileHeld) {
      try {
        await options.whileHeld(value);
      } catch (error) {
        reportError("Recording a billing change's outcome under its lease failed", error);
      }
    }
    return value;
  } finally {
    const { error } = await admin.rpc("release_billing_change_lock", {
      p_account_key: key,
      p_holder: holder,
    });
    // It expires on its own; until then the account's next change waits.
    if (error) reportError("Releasing the billing change lease failed", error);
  }
}

/**
 * Whether an approval's billing change may still be running, for the
 * asker's poll while the approval has no result: it does while its lease
 * (held under the approval's id, see BillingChangeRunOptions) is held and
 * unexpired, and for LEASE_CLAIM_GRACE_MS after it started, before the
 * lease is taken. A lease that cannot be read counts as held: the poll
 * asks again rather than answer that the outcome is unknown.
 */
export async function billingChangeStillRunning(
  userId: string,
  teamId: string | null,
  holder: string,
  startedAtMs: number
): Promise<boolean> {
  if (Date.now() - startedAtMs < LEASE_CLAIM_GRACE_MS) return true;
  const { data, error } = await createAdminClient()
    .from("billing_change_locks")
    .select("expires_at")
    .eq("account_key", accountKey(userId, teamId))
    .eq("holder", holder)
    .maybeSingle();
  if (error) {
    reportError("Reading a billing change's lease failed", error);
    return true;
  }
  return data !== null && Date.parse(data.expires_at) > Date.now();
}

async function runLocked(
  userId: string,
  request: BillingChangeRequest,
  approved: BillingQuote,
  lease: BillingChangeLease
): Promise<BillingChangeRun> {
  const quotedAt = Date.parse(approved.quotedAt);
  let again: BillingQuote;
  let fresh: BillingQuote;
  try {
    const loaded = await loadBillingQuote(userId, request);
    // Pricing can refuse too (a capacity change that is now a no-op, or
    // whose plan is ending): the state moved, so it is a changed quote.
    again = loaded.at(quotedAt);
    fresh = loaded.at(Date.now());
  } catch (error) {
    const refusal = refusalOf(error);
    if (!refusal) {
      // Nothing was touched: reading billing failed (Polar or the database
      // unreachable), so the approval goes back to pending.
      reportError("Quoting an approved billing change again failed", loggablePolarError(error));
      throw new BillingChangeRetry(
        503,
        "Billing could not be read just now, so nothing was changed. Try approving again in a minute."
      );
    }
    return {
      outcome: {
        executed: false,
        code: "quote_changed",
        reason: `Nothing was changed: ${refusal.message}`,
      },
    };
  }
  if (
    quoteFingerprint(again) !== quoteFingerprint(approved) ||
    fresh.dueNowCents > chargeCeiling(approved.dueNowCents)
  ) {
    return {
      outcome: {
        executed: false,
        code: "quote_changed",
        reason:
          "Nothing was changed: the price or the subscription changed after this was asked for. Ask again for a new quote.",
      },
    };
  }

  try {
    return await makeBillingChange(userId, request, again);
  } catch (error) {
    // The lease ran out or the run got too slow before its first change:
    // nothing reached Polar, so the approval may be approved again.
    if (error instanceof BillingChangeRetry && lease.mutations === 0) throw error;
    const refusal = changeRefusalOf(error);
    if (refusal) {
      return {
        outcome: {
          executed: false,
          code: refusal.code,
          reason: `Nothing was changed: ${refusal.message}`,
        },
      };
    }
    // A charge the cardholder's bank wants them to confirm (3-D Secure):
    // Polar may take the payment once they do, so it is neither made nor
    // refused yet.
    if (isPaymentActionRequired(error)) {
      return {
        outcome: {
          executed: null,
          code: "outcome_unknown",
          reason: PAYMENT_ACTION_REQUIRED,
        },
      };
    }
    // Polar may have made the change (a timeout once it landed, a write
    // after it that failed): never "nothing was changed", and never run
    // again by approving twice.
    reportError(
      "An approved billing change failed after Polar was asked",
      loggablePolarError(error),
      {
        teamId: request.teamId,
        change: request.change.kind,
      }
    );
    return { outcome: { ...BILLING_OUTCOME_UNKNOWN } };
  }
}

export const PAYMENT_ACTION_REQUIRED =
  "The bank wants the cardholder to confirm this payment (3-D Secure), so the change is not finished: Polar emails a link to confirm it, and once confirmed the change may be made. Check billing before asking again.";

export function isPaymentActionRequired(error: unknown): boolean {
  return (
    (error instanceof BillingActionError || error instanceof TeamBillingError) &&
    error.code === "payment_action_required"
  );
}

/**
 * Makes a change at once, priced by `quote`, with no quote check: the
 * approval's run above, and the agent budget (lib/billing/agent-budget.ts),
 * which quotes it under the same lease. Throws a refusal, or any error
 * Polar or the database raised; the caller holds the account's lease
 * (withBillingChangeLease) and reads errors as runLocked does.
 */
export async function makeBillingChange(
  userId: string,
  { teamId, change }: BillingChangeRequest,
  quote: BillingQuote
): Promise<BillingChangeRun> {
  if (change.kind === "capacity") {
    const account: CapacityAccount = teamId ? { kind: "team", teamId } : { kind: "user", userId };
    // A checkout sells exactly the approved count.
    const { url, unchanged } = await applyCapacityAction(account, userId, change.capacity, {
      exactUnits: true,
    });
    // The blocks renewed at that count already (Polar's own count, which the
    // quote could not see): nothing was made.
    if (unchanged) {
      return {
        outcome: {
          executed: false,
          code: "unchanged",
          reason: "Nothing was changed: the monthly blocks renew at that count already.",
        },
      };
    }
    return url
      ? { outcome: { executed: true, applied: "checkout", checkout: "opened" }, checkoutUrl: url }
      : {
          outcome: {
            executed: true,
            applied: change.capacity.action === "set_overage" ? "now" : "renewal",
          },
        };
  }
  if (teamId) {
    switch (change.kind) {
      case "plan": {
        const result = await changeTeamPlan(
          userId,
          teamId,
          change.plan as "team" | "team_business",
          change.interval,
          { periodEnd: String(quote.basis.periodEnd) }
        );
        return { outcome: { executed: true, ...result } };
      }
      case "seats": {
        // The seats as the database had them: what the increase compares
        // with right before Polar is asked (Polar's may differ after a
        // failed write, and asking again for its count is how that heals).
        // The direction is the quote's, priced on Polar's seats: when the
        // database would take the change another way, it refuses.
        await updateTeamSeats(userId, teamId, change.seats, {
          currentSeats: Number(quote.basis.teamSeats ?? quote.basis.currentSeats),
          periodEnd: String(quote.basis.periodEnd),
          direction: quotedSeatDirection(quote, change.seats),
        });
        return {
          outcome: { executed: true, applied: quote.applies === "renewal" ? "renewal" : "now" },
        };
      }
      case "keep_plan": {
        const team = await getTeamForOwner(userId, teamId);
        try {
          await keepTeamPlan(userId, teamId);
        } catch (error) {
          // The plan is kept, but Polar dropped the waiting seat reduction
          // with the plan change: made, and the owner sets the seats again.
          if (
            error instanceof TeamBillingError &&
            error.code === "seat_reduction_lost" &&
            team.pending_seats !== null
          ) {
            return {
              outcome: { executed: true, applied: "now", seatReductionLost: team.pending_seats },
            };
          }
          throw error;
        }
        return { outcome: { executed: true, applied: "now" } };
      }
      case "cancel":
        await cancelTeamSubscription(userId, teamId);
        return { outcome: { executed: true, applied: "renewal" } };
      case "resubscribe":
        await resubscribeTeam(userId, teamId);
        return { outcome: { executed: true, applied: "now" } };
    }
  }
  switch (change.kind) {
    case "plan":
      return {
        outcome: {
          executed: true,
          ...(await changePlanForUser(userId, change.plan as "pro" | "business", change.interval, {
            periodEnd: String(quote.basis.periodEnd),
          })),
        },
      };
    case "keep_plan":
      await keepCurrentPlanForUser(userId);
      return { outcome: { executed: true, applied: "now" } };
    case "cancel":
      await cancelSubscriptionForUser(userId);
      return { outcome: { executed: true, applied: "renewal" } };
    case "resubscribe":
      await resubscribeForUser(userId);
      return { outcome: { executed: true, applied: "now" } };
    default:
      throw new BillingChangeRefusal(400, "Seats belong to a team: name the team", "invalid_seats");
  }
}

/**
 * Which way a seat quote priced the change (`applies`): fewer seats wait for
 * the renewal, more are charged now, and the same count (cancelling a
 * waiting reduction) applies now with no charge. The quote's currentSeats
 * are Polar's.
 */
export function quotedSeatDirection(quote: BillingQuote, seats: number): SeatDirection {
  if (quote.applies === "renewal") return "reduction";
  return seats === Number(quote.basis.currentSeats) ? "same" : "increase";
}

/**
 * The audit event the change's own route writes, so the trail reads the
 * same whether a session made it or an approval did.
 */
export function auditActionFor({ teamId, change }: BillingChangeRequest): AuditAction {
  if (change.kind === "capacity") return `billing.capacity.${change.capacity.action}`;
  if (teamId) {
    return change.kind === "plan"
      ? "team.plan_changed"
      : change.kind === "keep_plan"
        ? "team.plan_kept"
        : change.kind === "seats"
          ? "team.seats_changed"
          : change.kind === "cancel"
            ? "team.subscription_canceled"
            : "team.subscription_resumed";
  }
  return change.kind === "cancel"
    ? "billing.subscription_canceled"
    : change.kind === "resubscribe"
      ? "billing.subscription_resumed"
      : "billing.plan_changed";
}
