/**
 * Seat pricing copy for the team plans: Teams and Team Business.
 *
 * Pure display helpers only. The authoritative seat range and request pool
 * live server-side in `lib/supabase/team-billing.ts` and Polar's products.
 * `MIN_TEAM_SEATS` and `MAX_TEAM_SEATS` mirror that module so the stepper
 * cannot offer a value the API would reject.
 */

/** A team's plan. */
export type TeamPlan = "team" | "team_business";
export type TeamInterval = "month" | "year";

/** Display price per seat, in whole US dollars, for Teams (monthly). */
export const TEAM_SEAT_PRICE_USD = 12;
/** Team Business, per seat: monthly, or for a year. */
export const TEAM_BUSINESS_SEAT_PRICE_USD = 35;
export const TEAM_BUSINESS_SEAT_ANNUAL_PRICE_USD = 350;

/** Both team plans start at two seats (the Polar products' first tier). */
export const MIN_TEAM_SEATS = 2;
export const MAX_TEAM_SEATS = 1000;
export const DEFAULT_TEAM_SEATS = 3;

/** The plans a team can be on, in the order they are offered. */
export const TEAM_PLAN_OPTIONS: ReadonlyArray<{ plan: TeamPlan; interval: TeamInterval }> = [
  { plan: "team", interval: "month" },
  { plan: "team_business", interval: "month" },
  { plan: "team_business", interval: "year" },
];

/** Price per seat in whole dollars for a plan and interval. */
export function teamSeatPriceUsd(plan: TeamPlan, interval: TeamInterval): number {
  if (plan === "team") return TEAM_SEAT_PRICE_USD;
  return interval === "year" ? TEAM_BUSINESS_SEAT_ANNUAL_PRICE_USD : TEAM_BUSINESS_SEAT_PRICE_USD;
}

/** "Teams", "Team Business" or "Team Business, annual". */
export function teamPlanLabel(plan: TeamPlan, interval: TeamInterval = "month"): string {
  if (plan === "team") return "Teams";
  return interval === "year" ? "Team Business, annual" : "Team Business";
}

/** Live checkout copy, e.g. `3 × $12/seat/mo = $36/mo`. */
export function formatSeatPricing(
  seats: number,
  plan: TeamPlan = "team",
  interval: TeamInterval = "month"
): string {
  const price = teamSeatPriceUsd(plan, interval);
  const unit = interval === "year" ? "yr" : "mo";
  return `${seats} × $${price}/seat/${unit} = $${(seats * price).toLocaleString("en-US")}/${unit}`;
}

/** Coerces stepper input to a whole seat count inside the allowed range. */
export function clampSeats(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEAM_SEATS;
  return Math.min(MAX_TEAM_SEATS, Math.max(MIN_TEAM_SEATS, Math.trunc(value)));
}

/** A seat change priced the way Polar bills it. All amounts are in cents. */
export interface SeatChangeQuote {
  currentSeats: number;
  newSeats: number;
  /** Seat count of a reduction already scheduled for the renewal; null when none. */
  pendingSeats: number | null;
  /**
   * True for a reduction: nothing is charged or credited now, the current
   * seats stay until `periodEnd`, and the subscription renews at `newSeats`.
   */
  appliesAtRenewal: boolean;
  pricePerSeatCents: number;
  /** Prorated price of an increase for the rest of the period; 0 for a reduction. */
  prorationCents: number;
  /** Unused account credit Polar spends on this charge first. */
  creditAppliedCents: number;
  /** What the card is charged on confirm; 0 for a reduction. */
  dueNowCents: number;
  /** Monthly price from the next renewal on. */
  renewalCents: number;
  /** End of the current period, ISO 8601. */
  periodEnd: string;
}

/**
 * Prices a seat change exactly as Polar bills it, verified against the
 * sandbox. An increase uses "invoice": the per-second share of the remaining
 * period, rounded down to the cent on the total (not per seat), with any
 * unused account credit spent before the card. A reduction uses
 * "next_period": nothing changes until the renewal, so it costs and credits
 * nothing now. Prices include VAT (the organization is tax-inclusive), so the
 * card pays exactly this.
 *
 * Time only shrinks the amount, so a charge made after the quote is never
 * higher than quoted.
 */
export function quoteSeatChange(input: {
  currentSeats: number;
  pendingSeats?: number | null;
  newSeats: number;
  pricePerSeatCents: number;
  periodStartMs: number;
  periodEndMs: number;
  creditBalanceCents: number;
  nowMs?: number;
}): SeatChangeQuote {
  const nowMs = input.nowMs ?? Date.now();
  const delta = input.newSeats - input.currentSeats;
  const periodMs = input.periodEndMs - input.periodStartMs;
  const remainingMs = Math.min(periodMs, Math.max(0, input.periodEndMs - nowMs));
  const prorationCents =
    delta > 0 && periodMs > 0
      ? Math.floor((delta * input.pricePerSeatCents * remainingMs) / periodMs)
      : 0;
  const creditAppliedCents = Math.min(Math.max(0, input.creditBalanceCents), prorationCents);

  return {
    currentSeats: input.currentSeats,
    newSeats: input.newSeats,
    pendingSeats: input.pendingSeats ?? null,
    appliesAtRenewal: delta < 0,
    pricePerSeatCents: input.pricePerSeatCents,
    prorationCents,
    creditAppliedCents,
    dueNowCents: prorationCents - creditAppliedCents,
    renewalCents: input.newSeats * input.pricePerSeatCents,
    periodEnd: new Date(input.periodEndMs).toISOString(),
  };
}

/**
 * Unused account credit from a customer's Polar orders: credit notes (negative
 * totals, e.g. from refunds or seat reductions billed before reductions moved
 * to the renewal) minus what later orders already spent
 * (`appliedBalanceAmount` is negative when credit was used). Polar exposes no
 * balance endpoint, so the order history is the source of truth.
 */
export function creditBalanceFromOrders(
  orders: ReadonlyArray<{ totalAmount: number; appliedBalanceAmount: number }>
): number {
  let balance = 0;
  for (const order of orders) {
    if (order.totalAmount < 0) balance -= order.totalAmount;
    if (order.appliedBalanceAmount < 0) balance += order.appliedBalanceAmount;
  }
  return Math.max(0, balance);
}

/** `$11.67` from cents, always with two decimals. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** A plan change priced the way Polar bills it. All amounts are in cents. */
export interface PlanChangeQuote {
  plan: TeamPlan;
  interval: TeamInterval;
  seats: number;
  /**
   * "now": an upgrade, charged at once ("invoice"); "renewal": a downgrade,
   * which changes nothing until the period ends.
   */
  applies: "now" | "renewal";
  /** The unused part of the current price, credited against the new one. */
  creditCents: number;
  /** The new price for what the change covers: the rest of the period, or a new year. */
  chargeCents: number;
  /** Unused account credit Polar spends first. */
  creditAppliedCents: number;
  /** About what the card is charged on confirm; 0 for a downgrade. */
  dueNowCents: number;
  /** The price the subscription renews at. */
  renewalCents: number;
  /** When the change applies or, for an upgrade, when the new plan first renews. */
  periodEnd: string;
}

/**
 * Prices a plan change as Polar bills it (checked in the sandbox). An
 * upgrade within the same interval keeps the period: Polar credits the
 * unused share of the current price and charges the same share of the new
 * one. A move to annual starts a new year at once: the full yearly price,
 * less the unused share of the month. A downgrade waits for the renewal and
 * costs nothing now. Rounding is Polar's, so the amount is "about".
 */
export function quotePlanChange(input: {
  plan: TeamPlan;
  interval: TeamInterval;
  seats: number;
  currentInterval: TeamInterval;
  currentAmountCents: number;
  newPricePerSeatCents: number;
  applies: "now" | "renewal";
  periodStartMs: number;
  periodEndMs: number;
  creditBalanceCents: number;
  nowMs?: number;
}): PlanChangeQuote {
  return {
    plan: input.plan,
    interval: input.interval,
    seats: input.seats,
    applies: input.applies,
    ...prorateProductSwitch({
      ...input,
      newAmountCents: input.seats * input.newPricePerSeatCents,
    }),
  };
}

/** What a product switch costs, as Polar bills it. All amounts are in cents. */
export interface ProductSwitchPrice {
  creditCents: number;
  chargeCents: number;
  creditAppliedCents: number;
  dueNowCents: number;
  renewalCents: number;
  periodEnd: string;
}

/**
 * The arithmetic behind quotePlanChange, for any subscription moving to
 * another product (a team's plan, or a person's: Pro to Business). "now"
 * with the same interval keeps the period, crediting the unused share of
 * the current price and charging the same share of the new one; "now" to
 * annual starts a new year at the full price less that credit; "renewal"
 * costs nothing now.
 */
export function prorateProductSwitch(input: {
  interval: TeamInterval;
  currentInterval: TeamInterval;
  currentAmountCents: number;
  newAmountCents: number;
  applies: "now" | "renewal";
  periodStartMs: number;
  periodEndMs: number;
  creditBalanceCents: number;
  nowMs?: number;
}): ProductSwitchPrice {
  const nowMs = input.nowMs ?? Date.now();
  const renewalCents = input.newAmountCents;
  const periodMs = input.periodEndMs - input.periodStartMs;
  const left = periodMs > 0 ? Math.min(1, Math.max(0, (input.periodEndMs - nowMs) / periodMs)) : 0;
  const newYear = input.interval === "year" && input.currentInterval !== "year";
  const now = input.applies === "now";
  const creditCents = now ? Math.round(input.currentAmountCents * left) : 0;
  const chargeCents = now ? (newYear ? renewalCents : Math.round(renewalCents * left)) : 0;
  const net = Math.max(0, chargeCents - creditCents);
  const creditAppliedCents = Math.min(Math.max(0, input.creditBalanceCents), net);
  const periodEnd = newYear
    ? new Date(nowMs).setUTCFullYear(new Date(nowMs).getUTCFullYear() + 1)
    : input.periodEndMs;
  return {
    creditCents,
    chargeCents,
    creditAppliedCents,
    dueNowCents: net - creditAppliedCents,
    renewalCents,
    periodEnd: new Date(periodEnd).toISOString(),
  };
}
