import { createAdminClient } from "./admin";
import { revokeTeamSubscription } from "./team-billing";
import type { Team, TeamRow } from "./teams-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMillis(timestamp: string | null): number {
  if (!timestamp) return Date.now();
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : Date.now();
}

// ---------------------------------------------------------------------------
// createTeam
// ---------------------------------------------------------------------------

/**
 * Anyone can create a team, regardless of personal plan. The team starts
 * unsubscribed (suspended) until its owner buys seats.
 */
export async function createTeam(userId: string, name: string): Promise<Team | { error: string }> {
  const admin = createAdminClient();

  // Atomic: insert team + owner member in one transaction via stored procedure
  const { data, error } = await admin.rpc("create_team_with_owner", {
    p_user_id: userId,
    p_name: name,
  });

  if (error) throw error;

  const result = data as {
    id?: string;
    name?: string;
    created_by?: string;
    created_at?: string;
    error?: string;
  };

  if (result.error) {
    return { error: result.error };
  }

  if (!result.id || !result.name || !result.created_by) {
    return { error: "Unexpected response from create_team_with_owner" };
  }

  return {
    id: result.id,
    name: result.name,
    createdBy: result.created_by,
    createdAt: parseMillis(result.created_at ?? null),
    memberCount: 1,
    role: "owner",
    suspended: true,
    subscriptionStatus: null,
    seats: 0,
    requestsUsed: 0,
    requestLimit: 0,
    periodEnd: null,
    cancelAtPeriodEnd: false,
  };
}

// ---------------------------------------------------------------------------
// listTeamsForUser
// ---------------------------------------------------------------------------

export async function listTeamsForUser(userId: string): Promise<Team[]> {
  const admin = createAdminClient();

  // Get all team memberships for user
  const { data: memberships, error: memberError } = await admin
    .from("team_members")
    .select("team_id, role")
    .eq("user_id", userId);

  if (memberError) throw memberError;
  if (!memberships || memberships.length === 0) return [];

  const membershipMap = new Map<string, "owner" | "member">(
    memberships.map((m) => [m.team_id, m.role])
  );
  const teamIds = Array.from(membershipMap.keys());

  // Fetch team rows, including their billing state
  const { data: teamsData, error: teamsError } = await admin
    .from("teams")
    .select(
      "id, name, created_by, created_at, subscription_status, seats, requests_used, request_limit, period_end, cancel_at_period_end"
    )
    .in("id", teamIds);

  if (teamsError) throw teamsError;

  const teams = (teamsData ?? []) as TeamRow[];

  // Batch: get all member counts
  const { data: allMembers, error: allMembersError } = await admin
    .from("team_members")
    .select("team_id")
    .in("team_id", teamIds);

  if (allMembersError) throw allMembersError;

  const countMap = new Map<string, number>();
  for (const row of allMembers ?? []) {
    countMap.set(row.team_id, (countMap.get(row.team_id) ?? 0) + 1);
  }

  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    createdBy: team.created_by,
    createdAt: parseMillis(team.created_at),
    memberCount: countMap.get(team.id) ?? 0,
    role: membershipMap.get(team.id) ?? ("member" as const),
    // A team is usable exactly while it has a subscription.
    suspended: team.subscription_status === null,
    subscriptionStatus: team.subscription_status,
    seats: team.seats,
    requestsUsed: team.requests_used,
    requestLimit: team.request_limit,
    periodEnd: team.period_end ? parseMillis(team.period_end) : null,
    cancelAtPeriodEnd: team.cancel_at_period_end,
  }));
}

// ---------------------------------------------------------------------------
// updateTeam
// ---------------------------------------------------------------------------

export async function updateTeam(userId: string, teamId: string, name: string): Promise<boolean> {
  const admin = createAdminClient();

  // Verify caller is owner
  const { data: membership, error: memberError } = await admin
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();

  if (memberError) throw memberError;
  if (!membership) return false;

  const { data, error } = await admin
    .from("teams")
    .update({ name })
    .eq("id", teamId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

// ---------------------------------------------------------------------------
// deleteTeam
// ---------------------------------------------------------------------------

export async function deleteTeam(userId: string, teamId: string): Promise<boolean> {
  const admin = createAdminClient();

  // Verify caller is owner
  const { data: membership, error: memberError } = await admin
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();

  if (memberError) throw memberError;
  if (!membership) return false;

  // Read the subscription id before the row goes away.
  const { data: teamRow, error: teamError } = await admin
    .from("teams")
    .select("polar_subscription_id")
    .eq("id", teamId)
    .maybeSingle();

  if (teamError) throw teamError;

  const { data, error } = await admin
    .from("teams")
    .delete()
    .eq("id", teamId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) return false;

  // Stop billing for a team that no longer exists. Polar failures are logged,
  // never surfaced: the team is already gone and retrying cannot bring it back.
  const subscriptionId = teamRow?.polar_subscription_id ?? null;
  if (subscriptionId) {
    try {
      await revokeTeamSubscription(subscriptionId);
    } catch (err) {
      console.error("[teams] failed to revoke subscription for deleted team", teamId, err);
    }
  }

  return true;
}
