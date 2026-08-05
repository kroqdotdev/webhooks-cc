import { createAdminClient } from "./admin";

// ---------------------------------------------------------------------------
// Shared subscription gating.
//
// Team access hangs off the team's own subscription, never a user's personal
// plan: a free user on a subscribed team has full team access, and a Pro user
// on an unsubscribed team has none.
// ---------------------------------------------------------------------------

export const TEAM_INACTIVE_MESSAGE = "This team needs an active Teams subscription";

/** Returns an error message when the team cannot be used, or null when it can. */
export async function requireActiveTeam(teamId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("teams")
    .select("subscription_status")
    .eq("id", teamId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return "Team not found";
  if (data.subscription_status === null) return TEAM_INACTIVE_MESSAGE;
  return null;
}

/**
 * True when the user belongs to any team at all, subscribed or not.
 *
 * This is the gate for a user's view of their OWN endpoints' share rows, which
 * is management surface rather than a paid feature: it exposes only shares the
 * caller created and the names of teams they already belong to. Gating it on a
 * subscription would hide the unshare control exactly when a team lapses,
 * stranding endpoints that are still shared.
 */
export async function hasAnyTeamMembership(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId)
    .limit(1);

  if (error) throw error;
  return (data ?? []).length > 0;
}

/** True when the user belongs to at least one subscribed team. */
export async function hasActiveTeamMembership(userId: string): Promise<boolean> {
  const admin = createAdminClient();

  // Two queries rather than a `teams!inner` embed: the generated Database type
  // declares no relationships, so embedded selects do not type-check here.
  const { data: memberships, error: membershipError } = await admin
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId);

  if (membershipError) throw membershipError;

  const teamIds = (memberships ?? []).map((row) => row.team_id);
  if (teamIds.length === 0) return false;

  const { data: activeTeams, error: teamsError } = await admin
    .from("teams")
    .select("id")
    .in("id", teamIds)
    .not("subscription_status", "is", null)
    .limit(1);

  if (teamsError) throw teamsError;
  return (activeTeams ?? []).length > 0;
}
