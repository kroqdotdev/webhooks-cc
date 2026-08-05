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
