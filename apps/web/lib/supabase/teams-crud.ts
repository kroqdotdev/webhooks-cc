import { createAdminClient } from "./admin";
import type { Team, TeamRow } from "./teams-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMillis(timestamp: string | null): number {
  if (!timestamp) return Date.now();
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : Date.now();
}

async function requirePro(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("users").select("plan").eq("id", userId).maybeSingle();

  if (error) throw error;
  if (!data || data.plan !== "pro") return "Teams require a Pro plan";
  return null;
}

// ---------------------------------------------------------------------------
// createTeam
// ---------------------------------------------------------------------------

export async function createTeam(userId: string, name: string): Promise<Team | { error: string }> {
  const proError = await requirePro(userId);
  if (proError) return { error: proError };

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
    suspended: false,
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

  // Fetch team rows
  const { data: teamsData, error: teamsError } = await admin
    .from("teams")
    .select("id, name, created_by, created_at")
    .in("id", teamIds);

  if (teamsError) throw teamsError;

  // Fetch member counts and owner plans
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

  // Batch: get owner plans to determine suspension
  const ownerIds = [...new Set(teams.map((t) => t.created_by))];
  const { data: ownerRows, error: ownerError } = await admin
    .from("users")
    .select("id, plan")
    .in("id", ownerIds);

  if (ownerError) throw ownerError;

  const ownerPlanMap = new Map((ownerRows ?? []).map((u) => [u.id, u.plan]));

  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    createdBy: team.created_by,
    createdAt: parseMillis(team.created_at),
    memberCount: countMap.get(team.id) ?? 0,
    role: membershipMap.get(team.id) ?? ("member" as const),
    suspended: ownerPlanMap.get(team.created_by) !== "pro",
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

  const { data, error } = await admin
    .from("teams")
    .delete()
    .eq("id", teamId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return !!data;
}
