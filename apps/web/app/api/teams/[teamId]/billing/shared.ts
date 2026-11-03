/**
 * HTTP status for each `TeamBillingError.code` thrown by `lib/supabase/team-billing`.
 * Shared by the team billing routes so a code means the same thing everywhere.
 * Unknown codes fall back to 400 at the call site.
 */
export const ERROR_STATUS: Record<string, number> = {
  not_owner: 403,
  team_not_found: 404,
  already_subscribed: 409,
  checkout_in_progress: 409,
  invalid_seats: 400,
  no_subscription: 409,
  no_customer: 409,
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

/** A team plan named in a request body or query. */
export function isTeamPlan(value: unknown): value is "team" | "team_business" {
  return value === "team" || value === "team_business";
}

/** A billing interval named in a request body or query. */
export function isInterval(value: unknown): value is "month" | "year" {
  return value === "month" || value === "year";
}
