import {
  BLOCK_PAGES,
  BLOCK_REQUESTS,
  MONTHLY_BLOCK_CENTS,
  MONTHLY_DOMAIN_CENTS,
  MONTHLY_PAGE_BLOCK_CENTS,
  ONE_TIME_BLOCK_CENTS,
  ONE_TIME_PAGE_BLOCK_CENTS,
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
} from "@/lib/supabase/team-billing";
import { formatCents, teamPlanLabel } from "@/lib/team-pricing";
import { isUuid } from "@/lib/uuid";

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
};

const TEAM_STATUS: Record<string, number> = {
  not_owner: 403,
  team_not_found: 404,
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
  seat_reduction_lost: 409,
};

/**
 * Our own refusals (checked before anything changed, or a declined card,
 * which changes nothing) as one error; null for anything else, which may
 * have failed after Polar made the change.
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
  teamName: string | null;
  at(nowMs: number): BillingQuote;
}

function planName(plan: string, interval: Interval): string {
  if (plan === "team" || plan === "team_business") return teamPlanLabel(plan, interval);
  const name = plan === "business" ? "Business" : plan === "pro" ? "Pro" : plan;
  return interval === "year" ? `${name} (annual)` : `${name} (monthly)`;
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
    const teamName = teamId ? (await getTeamForOwner(userId, teamId)).name : null;
    const state = await getCapacityState(account, change.capacity.resource ?? "requests");
    return { teamName, at: (nowMs) => capacityQuote(change.capacity, state, nowMs) };
  }
  return teamId ? loadTeamQuote(userId, teamId, change) : loadPersonalQuote(userId, change);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
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
          notes: now
            ? [
                `Charged the difference for the rest of this period: ${formatCents(q.chargeCents)} for ${to}, less ${formatCents(q.creditCents)} unused of ${from}${q.creditAppliedCents > 0 ? ` and ${formatCents(q.creditAppliedCents)} of account credit` : ""}.`,
                "The extra requests and parsed pages for this period come in the same proportion.",
              ]
            : ["Nothing changes until the renewal; until then the current plan stays."],
          basis: loaded.basis,
        };
      },
    };
  }

  const user = await getBillingUser(userId);
  if (!user.polar_subscription_id || user.plan === "free") {
    throw new BillingActionError("no_subscription", "No active subscription");
  }
  const basis = {
    subscriptionId: user.polar_subscription_id,
    plan: user.plan,
    interval: user.billing_interval,
    cancelAtPeriodEnd: user.cancel_at_period_end,
    pendingPlan: user.pending_plan,
  };
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
  const sentence =
    change.kind === "keep_plan"
      ? `Keep ${current}: drop the plan change waiting for the renewal.`
      : change.kind === "cancel"
        ? `Cancel ${current} at the end of the period.`
        : `Keep ${current}: undo the cancellation, so it renews.`;
  const end = await personalPeriodEnd(userId);
  return {
    teamName: null,
    at: (nowMs) => ({
      quotedAt: iso(nowMs),
      change: sentence,
      applies: change.kind === "cancel" ? "renewal" : "now",
      effectiveAt: change.kind === "cancel" ? end : iso(nowMs),
      dueNowCents: 0,
      approximate: false,
      renewalCents: null,
      notes:
        change.kind === "cancel"
          ? ["The plan, monthly blocks and overage stay until the period ends, then end with it."]
          : [],
      basis,
    }),
  };
}

async function personalPeriodEnd(userId: string): Promise<string | null> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("users")
    .select("billing_period_end, period_end")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.billing_period_end ?? data?.period_end ?? null;
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
      teamName: loaded.team.name,
      at: (nowMs) => {
        const q = loaded.at(nowMs);
        const from = teamPlanLabel(loaded.current.plan, loaded.current.interval);
        const to = teamPlanLabel(q.plan, q.interval);
        const now = q.applies === "now";
        const newYear = q.interval === "year" && loaded.current.interval !== "year";
        return {
          quotedAt: iso(nowMs),
          change: `Change the team "${loaded.team.name}" from ${from} to ${to} (${q.seats} ${q.seats === 1 ? "seat" : "seats"}).`,
          applies: q.applies,
          effectiveAt: now ? iso(nowMs) : q.periodEnd,
          dueNowCents: q.dueNowCents,
          approximate: now,
          renewalCents: q.renewalCents,
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
    };
  }
  if (change.kind === "seats") {
    const loaded = await loadTeamSeatQuote(userId, teamId, change.seats);
    if (change.seats === loaded.team.seats && loaded.team.pending_seats === null) {
      throw new TeamBillingError("unchanged", `The team has ${change.seats} seats already`);
    }
    return {
      teamName: loaded.team.name,
      at: (nowMs) => {
        const q = loaded.at(nowMs);
        const more = q.newSeats > q.currentSeats;
        return {
          quotedAt: iso(nowMs),
          change:
            q.newSeats === q.currentSeats
              ? `Keep ${q.currentSeats} seats on the team "${loaded.team.name}": drop the reduction to ${q.pendingSeats} waiting for the renewal.`
              : `Change the team "${loaded.team.name}" from ${q.currentSeats} to ${q.newSeats} seats.`,
          applies: more || q.newSeats === q.currentSeats ? "now" : "renewal",
          effectiveAt: q.appliesAtRenewal ? q.periodEnd : iso(nowMs),
          dueNowCents: q.dueNowCents,
          approximate: false,
          renewalCents: q.renewalCents,
          notes: more
            ? [
                `The added seats cost ${formatCents(q.prorationCents)} for the rest of this period${q.creditAppliedCents > 0 ? `, ${formatCents(q.creditAppliedCents)} of it from account credit` : ""}.`,
              ]
            : q.appliesAtRenewal
              ? ["The current seats stay until the renewal; nothing is credited."]
              : [],
          basis: loaded.basis,
        };
      },
    };
  }

  const team = await getTeamForOwner(userId, teamId);
  if (!team.polar_subscription_id || team.subscription_status === null) {
    throw new TeamBillingError("no_subscription", "No active subscription");
  }
  const current = teamPlanLabel(
    team.business ? "team_business" : "team",
    team.billing_interval === "year" ? "year" : "month"
  );
  if (change.kind === "keep_plan" && !team.pending_plan) {
    throw new TeamBillingError("unchanged", "No plan change is waiting");
  }
  if (change.kind === "cancel" && team.cancel_at_period_end) {
    throw new TeamBillingError("unchanged", "The subscription is already set to end");
  }
  if (change.kind === "resubscribe" && !team.cancel_at_period_end) {
    throw new TeamBillingError("not_scheduled", "Subscription is not scheduled for cancellation");
  }
  const basis = {
    subscriptionId: team.polar_subscription_id,
    status: team.subscription_status,
    business: team.business,
    interval: team.billing_interval,
    seats: team.seats,
    cancelAtPeriodEnd: team.cancel_at_period_end,
    pendingPlan: team.pending_plan,
    pendingSeats: team.pending_seats,
  };
  const sentence =
    change.kind === "keep_plan"
      ? `Keep the team "${team.name}" on ${current}: drop the plan change waiting for the renewal.`
      : change.kind === "cancel"
        ? `Cancel the team "${team.name}"'s ${current} subscription at the end of the period.`
        : `Keep the team "${team.name}"'s ${current} subscription: undo the cancellation, so it renews.`;
  const end = await teamPeriodEnd(teamId);
  return {
    teamName: team.name,
    at: (nowMs) => ({
      quotedAt: iso(nowMs),
      change: sentence,
      applies: change.kind === "cancel" ? "renewal" : "now",
      effectiveAt: change.kind === "cancel" ? end : iso(nowMs),
      dueNowCents: 0,
      approximate: false,
      renewalCents: null,
      notes:
        change.kind === "cancel"
          ? ["Members keep the team's endpoints and pool until the period ends."]
          : [],
      basis,
    }),
  };
}

async function teamPeriodEnd(teamId: string): Promise<string | null> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("teams")
    .select("billing_period_end, period_end")
    .eq("id", teamId)
    .maybeSingle();
  if (error) throw error;
  return data?.billing_period_end ?? data?.period_end ?? null;
}

/** What one block of a resource is, and costs. */
function blockFacts(resource: "requests" | "pages" | "domains") {
  if (resource === "pages") {
    return {
      monthly: MONTHLY_PAGE_BLOCK_CENTS,
      oneTime: ONE_TIME_PAGE_BLOCK_CENTS,
      size: BLOCK_PAGES,
      noun: (n: number) => `${(n * BLOCK_PAGES).toLocaleString("en-US")} parsed pages`,
    };
  }
  if (resource === "domains") {
    return {
      monthly: MONTHLY_DOMAIN_CENTS,
      oneTime: 0,
      size: 1,
      noun: (n: number) => `${n} extra ${n === 1 ? "domain" : "domains"}`,
    };
  }
  return {
    monthly: MONTHLY_BLOCK_CENTS,
    oneTime: ONE_TIME_BLOCK_CENTS,
    size: BLOCK_REQUESTS,
    noun: (n: number) => `${(n * BLOCK_REQUESTS).toLocaleString("en-US")} requests`,
  };
}

/**
 * A capacity change priced from the dashboard's own prices and the
 * account's add-on state, deciding as changeMonthlyBlocks and setOverage
 * do whether it is a checkout, made now, or from the renewal.
 */
export function capacityQuote(
  action: CapacityAction,
  state: CapacityState,
  nowMs: number
): BillingQuote {
  const resource = action.resource ?? "requests";
  const facts = blockFacts(resource);
  const blocks = state.blocks;
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
      change: `Buy ${facts.noun(action.blocks)} that never expire.`,
      applies: "checkout",
      effectiveAt: now,
      dueNowCents: action.blocks * facts.oneTime,
      renewalCents: null,
      notes: ["Paid at a Polar checkout that approving opens; nothing is bought until it is paid."],
    };
  }

  if (action.action === "set_monthly_blocks") {
    const target = action.blocks;
    const monthly = (n: number) => n * facts.monthly;
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
        change: `Add ${facts.noun(target)} every period.`,
        applies: "checkout",
        effectiveAt: now,
        dueNowCents: monthly(target),
        renewalCents: monthly(target),
        notes: [
          "Paid at a Polar checkout that approving opens, for the rest of this period; they then renew with the plan.",
        ],
      };
    }
    if (target === 0) {
      return {
        ...base,
        change: `End the ${facts.noun(blocks.units)} added every period.`,
        applies: "renewal",
        effectiveAt: state.periodEnd,
        dueNowCents: 0,
        renewalCents: 0,
        notes: ["They stay until the period ends and are not renewed."],
      };
    }
    if (target > blocks.units) {
      return {
        ...base,
        change: `Add ${facts.noun(target - blocks.units)} more every period (${facts.noun(target)} in all).`,
        applies: "checkout",
        effectiveAt: now,
        dueNowCents: monthly(target - blocks.units),
        renewalCents: monthly(target),
        notes: [
          "The added blocks are paid at their full monthly price at a Polar checkout that approving opens.",
        ],
      };
    }
    const renews = blocks.pendingUnits ?? blocks.units;
    if (target === renews && !blocks.cancelAtPeriodEnd) {
      throw unchanged(`The monthly blocks renew at ${facts.noun(target)} already`);
    }
    return {
      ...base,
      change:
        target === blocks.units
          ? `Keep ${facts.noun(target)} every period${blocks.cancelAtPeriodEnd ? " instead of ending them" : ", dropping the scheduled reduction"}.`
          : `Reduce the monthly blocks from ${facts.noun(blocks.units)} to ${facts.noun(target)} at the renewal.`,
      applies: "renewal",
      effectiveAt: state.periodEnd,
      dueNowCents: 0,
      renewalCents: monthly(target),
      notes: ["Nothing is charged or credited now."],
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
      change: `Turn off overage for ${noun}.`,
      applies: "now",
      effectiveAt: now,
      dueNowCents: 0,
      renewalCents: null,
      notes: ["Counting stops now; what was used this period is billed at its end."],
    };
  }
  const max =
    action.maxBlocks !== undefined
      ? action.maxBlocks * facts.size
      : state.overage.maxRequests > 0
        ? state.overage.maxRequests
        : null;
  const maxWords =
    max === null ? "the default maximum" : `at most ${max.toLocaleString("en-US")} ${noun}`;
  if (
    state.overage.subscribed &&
    !state.overage.cancelAtPeriodEnd &&
    max === state.overage.maxRequests
  ) {
    throw unchanged(`Overage is on with that maximum already`);
  }
  return {
    ...base,
    change: `Turn on overage for ${noun}, ${maxWords} a period.`,
    applies: state.overage.subscribed ? "now" : "checkout",
    effectiveAt: now,
    dueNowCents: 0,
    renewalCents: null,
    notes: [
      state.overage.subscribed
        ? "Nothing is charged now; what is used past the allowance is billed at the end of each period."
        : "Starts at a Polar checkout that approving opens (nothing is charged there); what is used is billed at the end of each period.",
    ],
  };
}

/** A quote as one canonical string, to compare two. */
export function quoteFingerprint(quote: BillingQuote): string {
  return canonical(quote);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

/**
 * Time alone moves a prorated charge by cents (Polar prices to the second):
 * a fresh quote may come out at most this much above the approved one.
 */
export function chargeCeiling(quotedCents: number): number {
  return quotedCents + Math.max(1, Math.ceil(quotedCents / 100));
}

/** What a billing approval did, kept for its asker. */
export type BillingChangeOutcome =
  | {
      executed: true;
      applied: "now" | "renewal" | "checkout";
      /** The checkout the owner was sent to, for a change paid there. */
      checkoutUrl?: string;
      seatReductionLost?: number;
    }
  | { executed: false; code: string; reason: string };

/**
 * Makes an approved change, only if a fresh quote, priced at the moment of
 * the ask, equals the approved one (same plan, prices, seats, period,
 * credit and subscription state) and the charge now is no more than time
 * explains. Otherwise nothing is changed and the outcome says why: the
 * asker asks again. A replay of a change already made finds the state it
 * changed and refuses, so nothing is ever made or charged twice.
 * Errors other than refusals propagate: they may come after Polar acted.
 */
export async function runBillingChange(
  userId: string,
  request: BillingChangeRequest,
  approved: BillingQuote
): Promise<BillingChangeOutcome> {
  const quotedAt = Date.parse(approved.quotedAt);
  let loaded: LoadedQuote;
  try {
    loaded = await loadBillingQuote(userId, request);
  } catch (error) {
    const refusal = refusalOf(error);
    if (!refusal) throw error;
    return {
      executed: false,
      code: "quote_changed",
      reason: `Nothing was changed: ${refusal.message}`,
    };
  }
  const again = loaded.at(quotedAt);
  const fresh = loaded.at(Date.now());
  if (
    quoteFingerprint(again) !== quoteFingerprint(approved) ||
    fresh.dueNowCents > chargeCeiling(approved.dueNowCents)
  ) {
    return {
      executed: false,
      code: "quote_changed",
      reason:
        "Nothing was changed: the price or the subscription changed after this was asked for. Ask again for a new quote.",
    };
  }

  try {
    return await makeChange(userId, request);
  } catch (error) {
    // A refusal is raised before Polar changes anything, or is a declined
    // card, which changes nothing either.
    const refusal = refusalOf(error);
    if (!refusal) throw error;
    return {
      executed: false,
      code: refusal.code,
      reason: `Nothing was changed: ${refusal.message}`,
    };
  }
}

async function makeChange(
  userId: string,
  { teamId, change }: BillingChangeRequest
): Promise<BillingChangeOutcome> {
  if (change.kind === "capacity") {
    const account: CapacityAccount = teamId ? { kind: "team", teamId } : { kind: "user", userId };
    const { url } = await applyCapacityAction(account, userId, change.capacity);
    return url
      ? { executed: true, applied: "checkout", checkoutUrl: url }
      : { executed: true, applied: change.capacity.action === "set_overage" ? "now" : "renewal" };
  }
  if (teamId) {
    switch (change.kind) {
      case "plan": {
        const result = await changeTeamPlan(
          userId,
          teamId,
          change.plan as "team" | "team_business",
          change.interval
        );
        return { executed: true, ...result };
      }
      case "seats": {
        const team = await getTeamForOwner(userId, teamId);
        await updateTeamSeats(userId, teamId, change.seats);
        return { executed: true, applied: change.seats < team.seats ? "renewal" : "now" };
      }
      case "keep_plan":
        await keepTeamPlan(userId, teamId);
        return { executed: true, applied: "now" };
      case "cancel":
        await cancelTeamSubscription(userId, teamId);
        return { executed: true, applied: "renewal" };
      case "resubscribe":
        await resubscribeTeam(userId, teamId);
        return { executed: true, applied: "now" };
    }
  }
  switch (change.kind) {
    case "plan":
      return {
        executed: true,
        ...(await changePlanForUser(userId, change.plan as "pro" | "business", change.interval)),
      };
    case "keep_plan":
      await keepCurrentPlanForUser(userId);
      return { executed: true, applied: "now" };
    case "cancel":
      await cancelSubscriptionForUser(userId);
      return { executed: true, applied: "renewal" };
    case "resubscribe":
      await resubscribeForUser(userId);
      return { executed: true, applied: "now" };
    default:
      throw new BillingChangeRefusal(400, "Seats belong to a team: name the team", "invalid_seats");
  }
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
