/**
 * Seat pricing copy for the Teams plan.
 *
 * Pure display helpers only — the authoritative seat range and request pool
 * live server-side in `lib/supabase/team-billing.ts`. `MAX_TEAM_SEATS` mirrors
 * that module so the stepper cannot offer a value the API would reject.
 */

/** Display price per seat, in whole US dollars. */
export const TEAM_SEAT_PRICE_USD = 12;

export const MIN_TEAM_SEATS = 1;
export const MAX_TEAM_SEATS = 1000;
export const DEFAULT_TEAM_SEATS = 3;

/** Live checkout copy, e.g. `3 × $12/seat/mo = $36/mo`. */
export function formatSeatPricing(seats: number): string {
  return `${seats} × $${TEAM_SEAT_PRICE_USD}/seat/mo = $${seats * TEAM_SEAT_PRICE_USD}/mo`;
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
