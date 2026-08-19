import { sendEmail } from "@/lib/email/mailer";
import { buildTeamInviteEmail } from "@/lib/email/team-invite-email";
import { publicEnv } from "@/lib/env";
import { createAdminClient } from "./admin";
import { assignTeamSeat, revokeTeamSeat } from "./team-billing";
import { requireActiveTeam, TEAM_INACTIVE_MESSAGE } from "./teams-gating";
import type { TeamInvite, TeamInviteRow } from "./teams-types";

/** Every purchased seat is occupied — membership is capped by seats, not plan. */
const NO_SEATS_MESSAGE = "Team has no available seats — ask the owner to add seats";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMillis(timestamp: string | null): number {
  if (!timestamp) return Date.now();
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : Date.now();
}

// ---------------------------------------------------------------------------
// createInvite
// ---------------------------------------------------------------------------

export async function createInvite(
  userId: string,
  teamId: string,
  email: string
): Promise<{ invite?: TeamInvite; warning?: string; error?: string }> {
  const admin = createAdminClient();
  const normalizedEmail = email.trim().toLowerCase();

  // Verify caller is owner
  const { data: callerMembership, error: callerError } = await admin
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();

  if (callerError) throw callerError;
  if (!callerMembership) return { error: "Not authorized" };

  // Only a subscribed team can seat anyone
  const activeError = await requireActiveTeam(teamId);
  if (activeError) return { error: activeError };

  // Purchased seats are the member cap
  const { count: memberCount, error: countError } = await admin
    .from("team_members")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId);

  if (countError) throw countError;

  const { data: teamSeats, error: seatsError } = await admin
    .from("teams")
    .select("seats")
    .eq("id", teamId)
    .maybeSingle();

  if (seatsError) throw seatsError;
  if ((memberCount ?? 0) >= (teamSeats?.seats ?? 0)) {
    return { error: NO_SEATS_MESSAGE };
  }

  // Inviter email and team name are needed for the self-invite check, the
  // invite email, and the response, so fetch them before the invitee lookup.
  const { data: inviterUser, error: inviterError } = await admin
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  if (inviterError) throw inviterError;

  const { data: teamData, error: teamError } = await admin
    .from("teams")
    .select("name")
    .eq("id", teamId)
    .maybeSingle();

  if (teamError) throw teamError;
  if (!teamData) return { error: "Team not found" };

  // Cannot invite self (by email; the account-id variant is checked below)
  if (inviterUser?.email?.toLowerCase() === normalizedEmail) {
    return { error: "You cannot invite yourself" };
  }

  // Look up the invited user by email. A miss is fine: the invite is created
  // unlinked and handle_new_user claims it when an account with this email
  // signs up.
  const { data: invitedUser, error: invitedUserError } = await admin
    .from("users")
    .select("id, email")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (invitedUserError) throw invitedUserError;

  if (invitedUser) {
    if (invitedUser.id === userId) return { error: "You cannot invite yourself" };

    // Check if already a member
    const { data: existingMember, error: existingMemberError } = await admin
      .from("team_members")
      .select("id")
      .eq("team_id", teamId)
      .eq("user_id", invitedUser.id)
      .maybeSingle();

    if (existingMemberError) throw existingMemberError;
    if (existingMember) return { error: "User is already a member of this team" };
  }

  // Check for an existing pending invite. Keyed on the email, not the user id:
  // unknown-address invites have no invited_user_id to match on.
  const { data: existingInvite, error: existingInviteError } = await admin
    .from("team_invites")
    .select("id")
    .eq("team_id", teamId)
    .eq("invited_email", normalizedEmail)
    .eq("status", "pending")
    .maybeSingle();

  if (existingInviteError) throw existingInviteError;
  if (existingInvite) return { error: "A pending invite already exists for this email" };

  // Delete any old declined/accepted invites so the unique constraint doesn't
  // block re-invites. A swallowed failure here would surface as a confusing
  // duplicate-invite error from the insert below.
  const { error: deleteError } = await admin
    .from("team_invites")
    .delete()
    .eq("team_id", teamId)
    .eq("invited_email", normalizedEmail)
    .in("status", ["declined", "accepted"]);

  if (deleteError) throw deleteError;

  // Insert invite
  const { data: inviteData, error: insertError } = await admin
    .from("team_invites")
    .insert({
      team_id: teamId,
      invited_by: userId,
      invited_email: normalizedEmail,
      invited_user_id: invitedUser?.id ?? null,
      status: "pending",
    })
    .select("id, team_id, invited_by, invited_email, invited_user_id, status, created_at")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return { error: "A pending invite already exists for this email" };
    }
    throw insertError;
  }

  const invite = inviteData as TeamInviteRow;

  // Close the signup race: an account created between the user lookup above
  // and the insert was linked by neither path (the handle_new_user trigger ran
  // before the invite existed, and the insert stored a null invited_user_id).
  // Re-check and link. Best effort: listPendingInvitesForUser and acceptInvite
  // both self-heal unlinked invites by email, so a failure here only delays
  // the link, it cannot lose the invite.
  if (!invitedUser) {
    try {
      const { data: lateUser, error: lateUserError } = await admin
        .from("users")
        .select("id")
        .eq("email", normalizedEmail)
        .maybeSingle();

      if (lateUserError) throw lateUserError;
      if (lateUser) {
        const { error: linkError } = await admin
          .from("team_invites")
          .update({ invited_user_id: lateUser.id })
          .eq("id", invite.id)
          .is("invited_user_id", null);

        if (linkError) throw linkError;
      }
    } catch (error) {
      console.error("[teams-invites] failed to link invite after signup race", { teamId, error });
    }
  }

  // Best-effort notification: the invite exists in-app regardless of whether
  // the email delivers, so a send failure downgrades to a warning.
  let warning: string | undefined;
  try {
    await sendEmail(
      buildTeamInviteEmail({
        inviterEmail: inviterUser?.email ?? "A webhooks.cc user",
        teamName: teamData.name,
        invitedEmail: normalizedEmail,
        appUrl: publicEnv().NEXT_PUBLIC_APP_URL,
      })
    );
  } catch (error) {
    console.error("[teams-invites] invite email send failed", { teamId, error });
    warning = "Invite created, but the notification email could not be sent";
  }

  return {
    invite: {
      id: invite.id,
      teamId: invite.team_id,
      teamName: teamData.name,
      invitedBy: invite.invited_by,
      inviterEmail: inviterUser?.email ?? "",
      invitedEmail: invite.invited_email,
      status: invite.status,
      createdAt: parseMillis(invite.created_at),
    },
    warning,
  };
}

// ---------------------------------------------------------------------------
// listPendingInvitesForUser
// ---------------------------------------------------------------------------

export async function listPendingInvitesForUser(userId: string): Promise<TeamInvite[]> {
  const admin = createAdminClient();

  const { data: invitesData, error: invitesError } = await admin
    .from("team_invites")
    .select("id, team_id, invited_by, invited_email, invited_user_id, status, created_at")
    .eq("invited_user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (invitesError) throw invitesError;

  // Self-heal: pending invites addressed to this account's email that never
  // got linked (a signup raced the invite insert, or the post-insert reconcile
  // failed) are surfaced and claimed here, making every listing a durable
  // retry of the linking rather than leaving such invites invisible forever.
  const { data: userRow, error: userError } = await admin
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  if (userError) throw userError;

  let unlinked: TeamInviteRow[] = [];
  if (userRow?.email) {
    const { data: unlinkedData, error: unlinkedError } = await admin
      .from("team_invites")
      .select("id, team_id, invited_by, invited_email, invited_user_id, status, created_at")
      .is("invited_user_id", null)
      .eq("invited_email", userRow.email.toLowerCase())
      .eq("status", "pending");

    if (unlinkedError) throw unlinkedError;
    unlinked = (unlinkedData ?? []) as TeamInviteRow[];

    if (unlinked.length > 0) {
      // Best effort: the rows are returned either way, and acceptInvite claims
      // unlinked invites by email itself, so a failed link here only delays it.
      const { error: linkError } = await admin
        .from("team_invites")
        .update({ invited_user_id: userId })
        .in(
          "id",
          unlinked.map((invite) => invite.id)
        )
        .is("invited_user_id", null);

      if (linkError) {
        console.error("[teams-invites] failed to self-heal unlinked invites", {
          userId,
          error: linkError,
        });
      }
    }
  }

  const invites = [...((invitesData ?? []) as TeamInviteRow[]), ...unlinked].sort(
    (a, b) => parseMillis(b.created_at) - parseMillis(a.created_at)
  );
  if (invites.length === 0) return [];

  // Collect team IDs and inviter IDs for batch lookups
  const teamIds = [...new Set(invites.map((i) => i.team_id))];
  const inviterIds = [...new Set(invites.map((i) => i.invited_by))];

  // Fetch teams
  const { data: teamsData, error: teamsError } = await admin
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
// listPendingInvitesForTeam
// ---------------------------------------------------------------------------

export async function listPendingInvitesForTeam(
  userId: string,
  teamId: string
): Promise<TeamInvite[] | null> {
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

  const { data: invitesData, error: invitesError } = await admin
    .from("team_invites")
    .select("id, team_id, invited_by, invited_email, invited_user_id, status, created_at")
    .eq("team_id", teamId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (invitesError) throw invitesError;
  if (!invitesData || invitesData.length === 0) return [];

  const invites = invitesData as TeamInviteRow[];

  // Fetch team name
  const { data: teamData, error: teamError } = await admin
    .from("teams")
    .select("name")
    .eq("id", teamId)
    .maybeSingle();

  if (teamError) throw teamError;
  const teamName = (teamData as { name: string } | null)?.name ?? "";

  // Collect invited user IDs and inviter IDs
  const invitedUserIds = [...new Set(invites.map((i) => i.invited_user_id))];
  const inviterIds = [...new Set(invites.map((i) => i.invited_by))];
  const allUserIds = [
    ...new Set([...invitedUserIds.filter((id): id is string => id !== null), ...inviterIds]),
  ];

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
// acceptInvite
// ---------------------------------------------------------------------------

export async function acceptInvite(
  userId: string,
  inviteId: string
): Promise<{ accepted: boolean; error?: string }> {
  const admin = createAdminClient();

  // The Polar seat has to be assigned before the membership row exists, so read
  // the invite's team and email up front. A non-pending or wrongly-addressed
  // invite short-circuits here, before any seat is spent.
  const { data: invite, error: inviteError } = await admin
    .from("team_invites")
    .select("team_id, invited_email, invited_user_id")
    .eq("id", inviteId)
    .eq("status", "pending")
    .maybeSingle();

  if (inviteError) throw inviteError;
  if (!invite) return { accepted: false };

  if (invite.invited_user_id !== userId) {
    // An unlinked invite (signup raced its creation) is claimable by the
    // account that owns the invited email; anything else is not the caller's
    // invite. Claiming here is what makes the linking durable: the RPC below
    // requires invited_user_id = caller.
    if (invite.invited_user_id !== null) return { accepted: false };

    const { data: caller, error: callerError } = await admin
      .from("users")
      .select("email")
      .eq("id", userId)
      .maybeSingle();

    if (callerError) throw callerError;
    if (!caller?.email || caller.email.toLowerCase() !== invite.invited_email.toLowerCase()) {
      return { accepted: false };
    }

    const { data: claimed, error: claimError } = await admin
      .from("team_invites")
      .update({ invited_user_id: userId })
      .eq("id", inviteId)
      .is("invited_user_id", null)
      .select("id")
      .maybeSingle();

    if (claimError) throw claimError;
    if (!claimed) return { accepted: false };
  }

  // An existing member re-accepting must not consume a second seat: the RPC's
  // insert is on-conflict-do-nothing, so a fresh assignment would be stranded.
  const { data: existingMember, error: memberError } = await admin
    .from("team_members")
    .select("id")
    .eq("team_id", invite.team_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (memberError) throw memberError;

  const seatId = existingMember
    ? null
    : await assignTeamSeat(invite.team_id, invite.invited_email, userId);

  // Atomic: claim invite + enforce the seat cap + insert member in one transaction
  let result: { status: string };
  try {
    const { data, error } = await admin.rpc("accept_team_invite", {
      p_user_id: userId,
      p_invite_id: inviteId,
      p_seat_id: seatId,
    });

    if (error) throw error;
    // Validate inside the try: a null or malformed payload dereferenced after
    // this block would throw past the compensation below and strand the seat.
    if (!data || typeof (data as { status?: unknown }).status !== "string") {
      throw new Error("accept_team_invite returned no status");
    }
    result = data as { status: string };
  } catch (rpcError) {
    // A failed RPC (timeout, pool exhaustion, restart) leaves the invite pending
    // with no membership row referencing the seat, so nothing downstream could
    // ever release it and a retry would assign a second one. Release it here and
    // rethrow; revokeTeamSeat swallows its own failures, so it cannot mask the
    // original error.
    if (seatId) {
      await revokeTeamSeat(invite.team_id, seatId, invite.invited_email);
    }
    throw rpcError;
  }

  if (result.status === "accepted") return { accepted: true };

  // The RPC refused and rolled the invite back — release the seat we just took.
  // Only ever the seat this call assigned: a null seat id would make
  // revokeTeamSeat fall back to an email lookup and could strip a seat the user
  // legitimately holds.
  if (seatId) {
    await revokeTeamSeat(invite.team_id, seatId, invite.invited_email);
  }

  if (result.status === "inactive") {
    return { accepted: false, error: TEAM_INACTIVE_MESSAGE };
  }
  if (result.status === "full") {
    return { accepted: false, error: NO_SEATS_MESSAGE };
  }

  return { accepted: false };
}

// ---------------------------------------------------------------------------
// declineInvite
// ---------------------------------------------------------------------------

export async function declineInvite(userId: string, inviteId: string): Promise<boolean> {
  const admin = createAdminClient();

  const { data: updated, error } = await admin
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
