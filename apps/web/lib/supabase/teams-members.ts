import { createAdminClient } from "./admin";
import { revokeTeamSeat } from "./team-billing";
import { removeMemberShares } from "./teams-endpoints";
import type { TeamMember, TeamMemberRow } from "./teams-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMillis(timestamp: string | null): number {
  if (!timestamp) return Date.now();
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : Date.now();
}

/**
 * Releases the Polar seat a departed member held. Called after the membership
 * row is gone; `revokeTeamSeat` swallows its own failures because our DB, not
 * Polar, is what gates team access.
 */
async function releaseMemberSeat(
  teamId: string,
  userId: string,
  seatId: string | null
): Promise<void> {
  const admin = createAdminClient();
  const { data: user, error } = await admin
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  // The membership row is already gone, so a failed lookup must not throw: it
  // would fail a removal that committed AND skip the seat release below. The
  // email is only the fallback lookup key inside revokeTeamSeat anyway; with a
  // known seat id the release works without it.
  if (error) {
    console.error("[teams-members] failed to read member email for seat release", {
      teamId,
      userId,
      error,
    });
  }

  await revokeTeamSeat(teamId, seatId, user?.email ?? "");
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

  // Fetch user profiles. Personal plan is deliberately absent: team access is
  // keyed to the team's own subscription.
  const { data: usersData, error: usersError } = await admin
    .from("users")
    .select("id, email, name, image")
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

  // The deleted row carries the seat assignment away with it, so read it back.
  const { data, error } = await admin
    .from("team_members")
    .delete()
    .eq("team_id", teamId)
    .eq("user_id", targetUserId)
    .select("id, polar_seat_id")
    .maybeSingle();

  if (error) throw error;
  if (!data) return false;

  await removeMemberShares(teamId, targetUserId);
  await releaseMemberSeat(teamId, targetUserId, data.polar_seat_id);
  return true;
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
    .select("id, polar_seat_id")
    .maybeSingle();

  if (error) throw error;
  if (!data) return false;

  await removeMemberShares(teamId, userId);
  await releaseMemberSeat(teamId, userId, data.polar_seat_id);
  return true;
}
