import { createAdminClient } from "./admin";
import type { TeamMember, TeamMemberRow } from "./teams-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMillis(timestamp: string | null): number {
  if (!timestamp) return Date.now();
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : Date.now();
}

// ---------------------------------------------------------------------------
// listTeamMembers
// ---------------------------------------------------------------------------

export async function listTeamMembers(
  userId: string,
  teamId: string
): Promise<TeamMember[] | null> {
  const admin = createAdminClient();

  // Verify caller is a member
  const { data: callerMembership, error: callerError } = await admin
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();

  if (callerError) throw callerError;
  if (!callerMembership) return null;

  // Fetch all members
  const { data: membersData, error: membersError } = await admin
    .from("team_members")
    .select("id, team_id, user_id, role, joined_at")
    .eq("team_id", teamId)
    .order("joined_at", { ascending: true });

  if (membersError) throw membersError;
  if (!membersData || membersData.length === 0) return [];

  const members = membersData as TeamMemberRow[];
  const userIds = members.map((m) => m.user_id);

  // Fetch user profiles (including plan)
  const { data: usersData, error: usersError } = await admin
    .from("users")
    .select("id, email, name, image, plan")
    .in("id", userIds);

  if (usersError) throw usersError;

  const userMap = new Map((usersData ?? []).map((u) => [u.id, u]));

  return members.map((m) => {
    const user = userMap.get(m.user_id);
    return {
      id: m.id,
      userId: m.user_id,
      email: user?.email ?? "",
      name: user?.name ?? null,
      image: user?.image ?? null,
      role: m.role,
      plan: (user?.plan === "pro" ? "pro" : "free") as "free" | "pro",
      joinedAt: parseMillis(m.joined_at),
    };
  });
}

// ---------------------------------------------------------------------------
// removeTeamMember
// ---------------------------------------------------------------------------

export async function removeTeamMember(
  userId: string,
  teamId: string,
  targetUserId: string
): Promise<boolean> {
  const admin = createAdminClient();

  // Cannot remove self
  if (userId === targetUserId) return false;

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
    .from("team_members")
    .delete()
    .eq("team_id", teamId)
    .eq("user_id", targetUserId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

// ---------------------------------------------------------------------------
// leaveTeam — non-owner members can leave voluntarily
// ---------------------------------------------------------------------------

export async function leaveTeam(userId: string, teamId: string): Promise<boolean> {
  const admin = createAdminClient();

  // Verify user is a member but NOT an owner (owners must transfer or delete)
  const { data: membership, error: memberError } = await admin
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();

  if (memberError) throw memberError;
  if (!membership) return false;
  if (membership.role === "owner") return false;

  const { data, error } = await admin
    .from("team_members")
    .delete()
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return !!data;
}
