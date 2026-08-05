/**
 * HTTP status for each `TeamBillingError.code` thrown by `lib/supabase/team-billing`.
 * Shared by the four team billing routes so a code means the same thing everywhere.
 * Unknown codes fall back to 400 at the call site.
 */
export const ERROR_STATUS: Record<string, number> = {
  not_owner: 403,
  team_not_found: 404,
  already_subscribed: 409,
  invalid_seats: 400,
  no_subscription: 409,
  not_scheduled: 409,
  seats_below_members: 409,
};
