import { createAdminClient } from "./admin";
import type { Json } from "./database";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  memberCount: number;
  role: "owner" | "member";
}

export interface TeamMember {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: "owner" | "member";
  joinedAt: number;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  teamName: string;
  invitedBy: string;
  inviterEmail: string;
  invitedEmail: string;
  status: "pending" | "accepted" | "declined";
  createdAt: number;
}

export interface TeamEndpointShare {
  teamId: string;
  teamName: string;
}

export interface SharedEndpoint {
  id: string;
  slug: string;
  name: string | null;
  url: string | undefined;
  mockResponse: {
    status: number;
    body: string;
    headers: Record<string, string>;
    delay?: number;
  } | null;
  isEphemeral: boolean;
  createdAt: number;
  fromTeam: { teamId: string; teamName: string };
  ownerId: string;
}

// ---------------------------------------------------------------------------
// Raw row shapes for new tables (not yet in generated database types)
// ---------------------------------------------------------------------------

interface TeamRow {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
}

interface TeamMemberRow {
  id: string;
  team_id: string;
  user_id: string;
  role: "owner" | "member";
  joined_at: string;
}

interface TeamInviteRow {
  id: string;
  team_id: string;
  invited_by: string;
  invited_email: string;
  invited_user_id: string;
  status: "pending" | "accepted" | "declined";
  created_at: string;
}

interface TeamEndpointRow {
  team_id: string;
  endpoint_id: string;
  shared_by: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMillis(timestamp: string | null): number {
  if (!timestamp) return Date.now();
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : Date.now();
}

function webhookUrl(slug: string): string | undefined {
  const base = process.env.WEBHOOK_BASE_URL ?? process.env.NEXT_PUBLIC_WEBHOOK_URL;
  if (!base) return undefined;
  return `${base}/w/${slug}`;
}

function normalizeMockHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string")
  ) as Record<string, string>;
}

function normalizeMockResponse(
  mock_response: Json | null
): SharedEndpoint["mockResponse"] {
  if (!mock_response || typeof mock_response !== "object" || Array.isArray(mock_response)) {
    return null;
  }
  const mr = mock_response as Record<string, unknown>;
  if (typeof mr.status !== "number") return null;
  return {
    status: mr.status,
    body: typeof mr.body === "string" ? mr.body : "",
    headers: normalizeMockHeaders(mr.headers),
    ...(typeof mr.delay === "number" &&
    Number.isInteger(mr.delay) &&
    mr.delay > 0 &&
    mr.delay <= 30000
      ? { delay: mr.delay }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 1. createTeam
// ---------------------------------------------------------------------------

export async function createTeam(userId: string, name: string): Promise<Team> {
  const admin = createAdminClient();

  // Insert the team
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: teamData, error: teamError } = await (admin as any)
    .from("teams")
    .insert({ name, created_by: userId })
    .select("id, name, created_by, created_at")
    .single();

  if (teamError) throw teamError;
  const team = teamData as TeamRow;

  // Add creator as owner member
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: memberError } = await (admin as any)
    .from("team_members")
    .insert({ team_id: team.id, user_id: userId, role: "owner" });

  if (memberError) throw memberError;

  return {
    id: team.id,
    name: team.name,
    createdBy: team.created_by,
    createdAt: parseMillis(team.created_at),
    memberCount: 1,
    role: "owner",
  };
}

// ---------------------------------------------------------------------------
// 2. listTeamsForUser
// ---------------------------------------------------------------------------

export async function listTeamsForUser(userId: string): Promise<Team[]> {
  const admin = createAdminClient();

  // Get all team memberships for user
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: memberships, error: memberError } = await (admin as any)
    .from("team_members")
    .select("team_id, role")
    .eq("user_id", userId);

  if (memberError) throw memberError;
  if (!memberships || memberships.length === 0) return [];

  const membershipMap = new Map<string, "owner" | "member">(
    (memberships as { team_id: string; role: "owner" | "member" }[]).map((m) => [m.team_id, m.role])
  );
  const teamIds = Array.from(membershipMap.keys());

  // Fetch team rows
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: teamsData, error: teamsError } = await (admin as any)
    .from("teams")
    .select("id, name, created_by, created_at")
    .in("id", teamIds);

  if (teamsError) throw teamsError;

  // Fetch member counts for each team
  const teams = (teamsData ?? []) as TeamRow[];
  const results: Team[] = [];

  for (const team of teams) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count, error: countError } = await (admin as any)
      .from("team_members")
      .select("id", { count: "exact", head: true })
      .eq("team_id", team.id);

    if (countError) throw countError;

    results.push({
      id: team.id,
      name: team.name,
      createdBy: team.created_by,
      createdAt: parseMillis(team.created_at),
      memberCount: count ?? 0,
      role: membershipMap.get(team.id) ?? "member",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 3. updateTeam
// ---------------------------------------------------------------------------

export async function updateTeam(
  userId: string,
  teamId: string,
  name: string
): Promise<boolean> {
  const admin = createAdminClient();

  // Verify caller is owner
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: membership, error: memberError } = await (admin as any)
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();

  if (memberError) throw memberError;
  if (!membership) return false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from("teams")
    .update({ name })
    .eq("id", teamId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

// ---------------------------------------------------------------------------
// 4. deleteTeam
// ---------------------------------------------------------------------------

export async function deleteTeam(userId: string, teamId: string): Promise<boolean> {
  const admin = createAdminClient();

  // Verify caller is owner
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: membership, error: memberError } = await (admin as any)
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();

  if (memberError) throw memberError;
  if (!membership) return false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from("teams")
    .delete()
    .eq("id", teamId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

// ---------------------------------------------------------------------------
// 5. listTeamMembers
// ---------------------------------------------------------------------------

export async function listTeamMembers(
  userId: string,
  teamId: string
): Promise<TeamMember[] | null> {
  const admin = createAdminClient();

  // Verify caller is a member
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: callerMembership, error: callerError } = await (admin as any)
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();

  if (callerError) throw callerError;
  if (!callerMembership) return null;

  // Fetch all members
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: membersData, error: membersError } = await (admin as any)
    .from("team_members")
    .select("id, team_id, user_id, role, joined_at")
    .eq("team_id", teamId)
    .order("joined_at", { ascending: true });

  if (membersError) throw membersError;
  if (!membersData || membersData.length === 0) return [];

  const members = membersData as TeamMemberRow[];
  const userIds = members.map((m) => m.user_id);

  // Fetch user profiles
  const { data: usersData, error: usersError } = await admin
    .from("users")
    .select("id, email, name, image")
    .in("id", userIds);

  if (usersError) throw usersError;

  const userMap = new Map(
    ((usersData ?? []) as { id: string; email: string; name: string | null; image: string | null }[]).map(
      (u) => [u.id, u]
    )
  );

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
// 6. removeTeamMember
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: membership, error: memberError } = await (admin as any)
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();

  if (memberError) throw memberError;
  if (!membership) return false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
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
// 7. createInvite
// ---------------------------------------------------------------------------

export async function createInvite(
  userId: string,
  teamId: string,
  email: string
): Promise<{ invite?: TeamInvite; error?: string }> {
  const admin = createAdminClient();

  // Verify caller is owner
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: callerMembership, error: callerError } = await (admin as any)
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();

  if (callerError) throw callerError;
  if (!callerMembership) return { error: "Not authorized" };

  // Look up invited user by email
  const { data: invitedUser, error: invitedUserError } = await admin
    .from("users")
    .select("id, email")
    .eq("email", email.toLowerCase())
    .maybeSingle();

  if (invitedUserError) throw invitedUserError;
  if (!invitedUser) return { error: "No account found with that email address" };

  // Cannot invite self
  if (invitedUser.id === userId) return { error: "You cannot invite yourself" };

  // Check if already a member
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingMember, error: existingMemberError } = await (admin as any)
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", invitedUser.id)
    .maybeSingle();

  if (existingMemberError) throw existingMemberError;
  if (existingMember) return { error: "User is already a member of this team" };

  // Check for existing pending invite
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingInvite, error: existingInviteError } = await (admin as any)
    .from("team_invites")
    .select("id")
    .eq("team_id", teamId)
    .eq("invited_user_id", invitedUser.id)
    .eq("status", "pending")
    .maybeSingle();

  if (existingInviteError) throw existingInviteError;
  if (existingInvite) return { error: "A pending invite already exists for this user" };

  // Delete any old declined/accepted invites so the unique constraint doesn't block re-invites
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from("team_invites")
    .delete()
    .eq("team_id", teamId)
    .eq("invited_email", email.toLowerCase().trim())
    .in("status", ["declined", "accepted"]);

  // Look up inviter email and team name for response
  const { data: inviterUser, error: inviterError } = await admin
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  if (inviterError) throw inviterError;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: teamData, error: teamError } = await (admin as any)
    .from("teams")
    .select("name")
    .eq("id", teamId)
    .maybeSingle();

  if (teamError) throw teamError;
  if (!teamData) return { error: "Team not found" };

  // Insert invite
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inviteData, error: insertError } = await (admin as any)
    .from("team_invites")
    .insert({
      team_id: teamId,
      invited_by: userId,
      invited_email: email.toLowerCase().trim(),
      invited_user_id: invitedUser.id,
      status: "pending",
    })
    .select("id, team_id, invited_by, invited_email, invited_user_id, status, created_at")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return { error: "A pending invite already exists for this user" };
    }
    throw insertError;
  }

  const invite = inviteData as TeamInviteRow;

  return {
    invite: {
      id: invite.id,
      teamId: invite.team_id,
      teamName: (teamData as { name: string }).name,
      invitedBy: invite.invited_by,
      inviterEmail: inviterUser?.email ?? "",
      invitedEmail: invitedUser.email,
      status: invite.status,
      createdAt: parseMillis(invite.created_at),
    },
  };
}

// ---------------------------------------------------------------------------
// 8. listPendingInvitesForUser
// ---------------------------------------------------------------------------

export async function listPendingInvitesForUser(userId: string): Promise<TeamInvite[]> {
  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: invitesData, error: invitesError } = await (admin as any)
    .from("team_invites")
    .select("id, team_id, invited_by, invited_email, invited_user_id, status, created_at")
    .eq("invited_user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (invitesError) throw invitesError;
  if (!invitesData || invitesData.length === 0) return [];

  const invites = invitesData as TeamInviteRow[];

  // Collect team IDs and inviter IDs for batch lookups
  const teamIds = [...new Set(invites.map((i) => i.team_id))];
  const inviterIds = [...new Set(invites.map((i) => i.invited_by))];

  // Fetch teams
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: teamsData, error: teamsError } = await (admin as any)
    .from("teams")
    .select("id, name")
    .in("id", teamIds);

  if (teamsError) throw teamsError;

  const teamMap = new Map(
    ((teamsData ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name])
  );

  // Fetch inviter emails
  const { data: invitersData, error: invitersError } = await admin
    .from("users")
    .select("id, email")
    .in("id", inviterIds);

  if (invitersError) throw invitersError;

  const inviterMap = new Map(
    ((invitersData ?? []) as { id: string; email: string }[]).map((u) => [u.id, u.email])
  );

  return invites.map((invite) => ({
    id: invite.id,
    teamId: invite.team_id,
    teamName: teamMap.get(invite.team_id) ?? "",
    invitedBy: invite.invited_by,
    inviterEmail: inviterMap.get(invite.invited_by) ?? "",
    invitedEmail: invite.invited_email,
    status: invite.status,
    createdAt: parseMillis(invite.created_at),
  }));
}

// ---------------------------------------------------------------------------
// 9. listPendingInvitesForTeam
// ---------------------------------------------------------------------------

export async function listPendingInvitesForTeam(
  userId: string,
  teamId: string
): Promise<TeamInvite[] | null> {
  const admin = createAdminClient();

  // Verify caller is a member
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: callerMembership, error: callerError } = await (admin as any)
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();

  if (callerError) throw callerError;
  if (!callerMembership) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: invitesData, error: invitesError } = await (admin as any)
    .from("team_invites")
    .select("id, team_id, invited_by, invited_email, invited_user_id, status, created_at")
    .eq("team_id", teamId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (invitesError) throw invitesError;
  if (!invitesData || invitesData.length === 0) return [];

  const invites = invitesData as TeamInviteRow[];

  // Fetch team name
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: teamData, error: teamError } = await (admin as any)
    .from("teams")
    .select("name")
    .eq("id", teamId)
    .maybeSingle();

  if (teamError) throw teamError;
  const teamName = (teamData as { name: string } | null)?.name ?? "";

  // Collect invited user IDs and inviter IDs
  const invitedUserIds = [...new Set(invites.map((i) => i.invited_user_id))];
  const inviterIds = [...new Set(invites.map((i) => i.invited_by))];
  const allUserIds = [...new Set([...invitedUserIds, ...inviterIds])];

  // Fetch user emails
  const { data: usersData, error: usersError } = await admin
    .from("users")
    .select("id, email")
    .in("id", allUserIds);

  if (usersError) throw usersError;

  const userEmailMap = new Map(
    ((usersData ?? []) as { id: string; email: string }[]).map((u) => [u.id, u.email])
  );

  return invites.map((invite) => ({
    id: invite.id,
    teamId: invite.team_id,
    teamName,
    invitedBy: invite.invited_by,
    inviterEmail: userEmailMap.get(invite.invited_by) ?? "",
    invitedEmail: invite.invited_email,
    status: invite.status,
    createdAt: parseMillis(invite.created_at),
  }));
}

// ---------------------------------------------------------------------------
// 10. acceptInvite
// ---------------------------------------------------------------------------

export async function acceptInvite(userId: string, inviteId: string): Promise<boolean> {
  const admin = createAdminClient();

  // Atomically claim the invite by updating status from pending → accepted
  // Only the invited user can claim it, and only if still pending (prevents race conditions)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: claimed, error: claimError } = await (admin as any)
    .from("team_invites")
    .update({ status: "accepted" })
    .eq("id", inviteId)
    .eq("invited_user_id", userId)
    .eq("status", "pending")
    .select("id, team_id")
    .maybeSingle();

  if (claimError) throw claimError;
  if (!claimed) return false;

  const inviteRow = claimed as { id: string; team_id: string };

  // Add as team member
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: memberError } = await (admin as any)
    .from("team_members")
    .insert({ team_id: inviteRow.team_id, user_id: userId, role: "member" });

  if (memberError) {
    // Ignore unique constraint — user might already be a member
    if (memberError.code !== "23505") throw memberError;
  }

  return true;
}

// ---------------------------------------------------------------------------
// 11. declineInvite
// ---------------------------------------------------------------------------

export async function declineInvite(userId: string, inviteId: string): Promise<boolean> {
  const admin = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error } = await (admin as any)
    .from("team_invites")
    .update({ status: "declined" })
    .eq("id", inviteId)
    .eq("invited_user_id", userId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return !!updated;
}

// ---------------------------------------------------------------------------
// 12. shareEndpointWithTeam
// ---------------------------------------------------------------------------

export async function shareEndpointWithTeam(
  userId: string,
  teamId: string,
  endpointId: string
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();

  // Verify user owns the endpoint
  const { data: endpoint, error: endpointError } = await admin
    .from("endpoints")
    .select("id")
    .eq("id", endpointId)
    .eq("user_id", userId)
    .maybeSingle();

  if (endpointError) throw endpointError;
  if (!endpoint) return { success: false, error: "Endpoint not found or not owned by you" };

  // Verify user is a team member
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: membership, error: memberError } = await (admin as any)
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();

  if (memberError) throw memberError;
  if (!membership) return { success: false, error: "You are not a member of this team" };

  // Insert share
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insertError } = await (admin as any)
    .from("team_endpoints")
    .insert({ team_id: teamId, endpoint_id: endpointId, shared_by: userId });

  if (insertError) {
    if (insertError.code === "23505") {
      return { success: false, error: "Endpoint is already shared with this team" };
    }
    throw insertError;
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// 13. unshareEndpointFromTeam
// ---------------------------------------------------------------------------

export async function unshareEndpointFromTeam(
  userId: string,
  teamId: string,
  endpointId: string
): Promise<boolean> {
  const admin = createAdminClient();

  // Verify user owns the endpoint
  const { data: endpoint, error: endpointError } = await admin
    .from("endpoints")
    .select("id")
    .eq("id", endpointId)
    .eq("user_id", userId)
    .maybeSingle();

  if (endpointError) throw endpointError;
  if (!endpoint) return false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from("team_endpoints")
    .delete()
    .eq("team_id", teamId)
    .eq("endpoint_id", endpointId)
    .select("endpoint_id")
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

// ---------------------------------------------------------------------------
// 14. getTeamSharesForEndpoint
// ---------------------------------------------------------------------------

export async function getTeamSharesForEndpoint(
  userId: string,
  endpointId: string
): Promise<TeamEndpointShare[]> {
  const admin = createAdminClient();

  // Verify user owns the endpoint
  const { data: endpoint, error: endpointError } = await admin
    .from("endpoints")
    .select("id")
    .eq("id", endpointId)
    .eq("user_id", userId)
    .maybeSingle();

  if (endpointError) throw endpointError;
  if (!endpoint) return [];

  // Fetch team_endpoints rows
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: sharesData, error: sharesError } = await (admin as any)
    .from("team_endpoints")
    .select("team_id, endpoint_id, shared_by")
    .eq("endpoint_id", endpointId);

  if (sharesError) throw sharesError;
  if (!sharesData || sharesData.length === 0) return [];

  const shares = sharesData as TeamEndpointRow[];
  const teamIds = [...new Set(shares.map((s) => s.team_id))];

  // Fetch team names
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: teamsData, error: teamsError } = await (admin as any)
    .from("teams")
    .select("id, name")
    .in("id", teamIds);

  if (teamsError) throw teamsError;

  const teamMap = new Map(
    ((teamsData ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name])
  );

  return shares.map((s) => ({
    teamId: s.team_id,
    teamName: teamMap.get(s.team_id) ?? "",
  }));
}

// ---------------------------------------------------------------------------
// 15. getSharedEndpointsForUser
// ---------------------------------------------------------------------------

export async function getSharedEndpointsForUser(userId: string): Promise<SharedEndpoint[]> {
  const admin = createAdminClient();

  // Get all teams the user is a member of
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: memberships, error: memberError } = await (admin as any)
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId);

  if (memberError) throw memberError;
  if (!memberships || memberships.length === 0) return [];

  const teamIds = (memberships as { team_id: string }[]).map((m) => m.team_id);

  // Fetch team names
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: teamsData, error: teamsError } = await (admin as any)
    .from("teams")
    .select("id, name")
    .in("id", teamIds);

  if (teamsError) throw teamsError;

  const teamMap = new Map(
    ((teamsData ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name])
  );

  // Fetch all shared endpoints for these teams
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: sharesData, error: sharesError } = await (admin as any)
    .from("team_endpoints")
    .select("team_id, endpoint_id, shared_by")
    .in("team_id", teamIds);

  if (sharesError) throw sharesError;
  if (!sharesData || sharesData.length === 0) return [];

  const shares = sharesData as TeamEndpointRow[];

  // Fetch endpoint data, excluding user's own endpoints
  const endpointIds = [...new Set(shares.map((s) => s.endpoint_id))];

  const { data: endpointsData, error: endpointsError } = await admin
    .from("endpoints")
    .select("id, user_id, slug, name, mock_response, is_ephemeral, created_at")
    .in("id", endpointIds)
    .neq("user_id", userId);

  if (endpointsError) throw endpointsError;
  if (!endpointsData || endpointsData.length === 0) return [];

  type EndpointMinRow = {
    id: string;
    user_id: string | null;
    slug: string;
    name: string | null;
    mock_response: Json | null;
    is_ephemeral: boolean;
    created_at: string;
  };

  const endpointMap = new Map(
    (endpointsData as EndpointMinRow[]).map((e) => [e.id, e])
  );

  // Build result — one entry per (endpoint, team) share, deduplicated to first team per endpoint
  const seen = new Set<string>();
  const results: SharedEndpoint[] = [];

  for (const share of shares) {
    const ep = endpointMap.get(share.endpoint_id);
    if (!ep) continue;
    if (seen.has(share.endpoint_id)) continue;
    seen.add(share.endpoint_id);

    results.push({
      id: ep.id,
      slug: ep.slug,
      name: ep.name,
      url: webhookUrl(ep.slug),
      mockResponse: normalizeMockResponse(ep.mock_response),
      isEphemeral: ep.is_ephemeral,
      createdAt: parseMillis(ep.created_at),
      fromTeam: {
        teamId: share.team_id,
        teamName: teamMap.get(share.team_id) ?? "",
      },
      ownerId: ep.user_id ?? "",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 16. resolveEndpointAccess
// ---------------------------------------------------------------------------

export async function resolveEndpointAccess(
  userId: string,
  slug: string
): Promise<{ endpointId: string; ownerId: string; isOwner: boolean } | null> {
  const admin = createAdminClient();

  // Look up endpoint by slug
  const { data: endpoint, error: endpointError } = await admin
    .from("endpoints")
    .select("id, user_id")
    .eq("slug", slug.toLowerCase())
    .maybeSingle();

  if (endpointError) throw endpointError;
  if (!endpoint) return null;

  const ownerId = endpoint.user_id ?? "";

  // Check ownership
  if (endpoint.user_id === userId) {
    return { endpointId: endpoint.id, ownerId, isOwner: true };
  }

  // Check team access: user must be a team member AND endpoint must be shared with that team
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: teamAccess, error: teamAccessError } = await (admin as any)
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId);

  if (teamAccessError) throw teamAccessError;
  if (!teamAccess || teamAccess.length === 0) return null;

  const userTeamIds = (teamAccess as { team_id: string }[]).map((m) => m.team_id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: shareAccess, error: shareAccessError } = await (admin as any)
    .from("team_endpoints")
    .select("team_id")
    .eq("endpoint_id", endpoint.id)
    .in("team_id", userTeamIds)
    .limit(1);

  if (shareAccessError) throw shareAccessError;
  if (!shareAccess || (shareAccess as unknown[]).length === 0) return null;

  return { endpointId: endpoint.id, ownerId, isOwner: false };
}

// ---------------------------------------------------------------------------
// 17. getShareMetadataForOwnedEndpoints
// ---------------------------------------------------------------------------

export async function getShareMetadataForOwnedEndpoints(
  userId: string
): Promise<Map<string, TeamEndpointShare[]>> {
  const admin = createAdminClient();

  // Fetch all endpoints owned by user
  const { data: endpointsData, error: endpointsError } = await admin
    .from("endpoints")
    .select("id")
    .eq("user_id", userId);

  if (endpointsError) throw endpointsError;
  if (!endpointsData || endpointsData.length === 0) return new Map();

  const endpointIds = endpointsData.map((e) => e.id);

  // Fetch all team_endpoint shares for those endpoints
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: sharesData, error: sharesError } = await (admin as any)
    .from("team_endpoints")
    .select("team_id, endpoint_id, shared_by")
    .in("endpoint_id", endpointIds);

  if (sharesError) throw sharesError;
  if (!sharesData || sharesData.length === 0) return new Map();

  const shares = sharesData as TeamEndpointRow[];
  const teamIds = [...new Set(shares.map((s) => s.team_id))];

  // Fetch team names
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: teamsData, error: teamsError } = await (admin as any)
    .from("teams")
    .select("id, name")
    .in("id", teamIds);

  if (teamsError) throw teamsError;

  const teamMap = new Map(
    ((teamsData ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name])
  );

  // Build map of endpointId → TeamEndpointShare[]
  const result = new Map<string, TeamEndpointShare[]>();

  for (const share of shares) {
    const existing = result.get(share.endpoint_id) ?? [];
    existing.push({
      teamId: share.team_id,
      teamName: teamMap.get(share.team_id) ?? "",
    });
    result.set(share.endpoint_id, existing);
  }

  return result;
}
