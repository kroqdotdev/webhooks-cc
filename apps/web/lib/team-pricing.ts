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

/**
 * Approximate prorated price, in US dollars, of changing a subscription by
 * `seatDelta` seats for the rest of the billing period ending at
 * `periodEndMs`. Polar prorates per second over the billing month, so the
 * period is taken as the calendar month before `periodEndMs`. Display only:
 * the charged amount comes from Polar and excludes tax.
 */
export function estimateSeatProration(
  seatDelta: number,
  periodEndMs: number | null,
  nowMs: number = Date.now()
): number | null {
  if (periodEndMs === null || !Number.isFinite(periodEndMs)) return null;

  const periodStart = new Date(periodEndMs);
  periodStart.setUTCMonth(periodStart.getUTCMonth() - 1);
  const periodLength = periodEndMs - periodStart.getTime();
  if (periodLength <= 0) return null;

  const remaining = Math.min(1, Math.max(0, (periodEndMs - nowMs) / periodLength));
  return Math.abs(seatDelta) * TEAM_SEAT_PRICE_USD * remaining;
}

/** `$11.67`, always with cents. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
