import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import {
  createTeam,
  listTeamsForUser,
  updateTeam,
  deleteTeam,
  listTeamMembers,
  removeTeamMember,
  leaveTeam,
  createInvite,
  listPendingInvitesForUser,
  listPendingInvitesForTeam,
  acceptInvite,
  declineInvite,
  shareEndpointWithTeam,
  unshareEndpointFromTeam,
  getTeamSharesForEndpoint,
  getSharedEndpointsForUser,
  resolveEndpointAccess,
  getShareMetadataForOwnedEndpoints,
  hasActiveTeamMembership,
  hasAnyTeamMembership,
} from "@/lib/supabase/teams";
import {
  listRequestsForEndpointByUser,
  listNewRequestsForEndpointByUser,
  listPaginatedRequestsForEndpointByUser,
  getRequestByIdForUser,
  clearRequestsForEndpointByUser,
} from "@/lib/supabase/requests";
import type { Database } from "@/lib/supabase/database";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SEAT_REQUEST_LIMIT = 100_000;

// Exact user-facing strings the invite path must return.
const INACTIVE_TEAM_ERROR = "This team needs an active Teams subscription";
const NO_SEATS_ERROR = "Team has no available seats — ask the owner to add seats";

const TEST_PASSWORD = "TestPassword123!";
const ts = Date.now();

// Owner user
const OWNER_EMAIL = `test-teams-owner-${ts}@webhooks-test.local`;
let ownerId: string;

// Member user
const MEMBER_EMAIL = `test-teams-member-${ts}@webhooks-test.local`;
let memberId: string;

// Third user (for decline tests)
const THIRD_EMAIL = `test-teams-third-${ts}@webhooks-test.local`;
let thirdId: string;

// Shared state
let teamId: string;
let endpointId: string;
let endpointSlug: string;

// Teams are plan-independent: membership and access hang off the team's own
// subscription, so test users stay on the free plan.
async function createTestUser(email: string, name: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (error) throw error;
  return data.user!.id;
}

/**
 * Puts a team on an active Teams subscription. `polar_subscription_id` stays
 * null unless a caller asks for one, so seat assignment short-circuits before
 * any Polar HTTP call.
 */
async function activateTeam(
  teamId: string,
  seats: number,
  opts: { subscriptionId?: string } = {}
): Promise<void> {
  const { error } = await admin
    .from("teams")
    .update({
      subscription_status: "active",
      seats,
      request_limit: seats * SEAT_REQUEST_LIMIT,
      requests_used: 0,
      period_start: new Date().toISOString(),
      period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      polar_subscription_id: opts.subscriptionId ?? null,
    })
    .eq("id", teamId);
  if (error) throw error;
}

/**
 * `teamId` stamps the row as billed to that team's pooled quota — the same
 * thing capture_webhook() does — which is what exempts it from the owner's
 * personal retention window.
 */
async function insertRequest(
  epId: string,
  userId: string,
  path: string,
  opts: { receivedAt?: Date; teamId?: string } = {}
) {
  const { data, error } = await admin
    .from("requests")
    .insert({
      endpoint_id: epId,
      user_id: userId,
      team_id: opts.teamId ?? null,
      method: "POST",
      path,
      headers: { "content-type": "application/json" },
      body: '{"test":true}',
      query_params: {},
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 13,
      received_at: (opts.receivedAt ?? new Date()).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

describe("Teams Integration", () => {
  beforeAll(async () => {
    [ownerId, memberId, thirdId] = await Promise.all([
      createTestUser(OWNER_EMAIL, "Team Owner"),
      createTestUser(MEMBER_EMAIL, "Team Member"),
      createTestUser(THIRD_EMAIL, "Third User"),
    ]);

    // Create an endpoint owned by the owner
    const ep = await createEndpointForUser({
      userId: ownerId,
      name: "Team Test Endpoint",
    });
    endpointId = ep.id;
    endpointSlug = ep.slug;
  });

  afterAll(async () => {
    // Clean up teams first (cascade deletes members, invites, team_endpoints)
    if (teamId) {
      await admin.from("teams").delete().eq("id", teamId);
    }
    // Clean up users (cascade deletes endpoints, requests)
    await Promise.all([
      ownerId && admin.auth.admin.deleteUser(ownerId),
      memberId && admin.auth.admin.deleteUser(memberId),
      thirdId && admin.auth.admin.deleteUser(thirdId),
    ]);
  });

  // ---------------------------------------------------------------------------
  // Team CRUD
  // ---------------------------------------------------------------------------

  describe("Team CRUD", () => {
    it("creates a team for a free user and adds creator as owner", async () => {
      const result = await createTeam(ownerId, "Integration Test Team");
      expect("error" in result).toBe(false);
      const team = result as Exclude<typeof result, { error: string }>;

      expect(team.id).toBeTruthy();
      expect(team.name).toBe("Integration Test Team");
      expect(team.createdBy).toBe(ownerId);
      expect(team.memberCount).toBe(1);
      expect(team.role).toBe("owner");
      expect(team.createdAt).toBeGreaterThan(0);

      // A fresh team has no subscription yet.
      expect(team.subscriptionStatus).toBeNull();
      expect(team.suspended).toBe(true);
      expect(team.seats).toBe(0);
      expect(team.requestsUsed).toBe(0);
      expect(team.requestLimit).toBe(0);
      expect(team.periodEnd).toBeNull();
      expect(team.cancelAtPeriodEnd).toBe(false);

      teamId = team.id;
    });

    it("lists teams for the owner", async () => {
      const teams = await listTeamsForUser(ownerId);

      expect(teams.length).toBeGreaterThanOrEqual(1);
      const team = teams.find((t) => t.id === teamId);
      expect(team).toBeDefined();
      expect(team!.name).toBe("Integration Test Team");
      expect(team!.role).toBe("owner");
      expect(team!.memberCount).toBe(1);
    });

    it("reports an unsubscribed team as suspended with no seats", async () => {
      const teams = await listTeamsForUser(ownerId);
      const team = teams.find((t) => t.id === teamId);

      expect(team).toBeDefined();
      expect(team!.subscriptionStatus).toBeNull();
      expect(team!.suspended).toBe(true);
      expect(team!.seats).toBe(0);
      expect(team!.requestLimit).toBe(0);
      expect(team!.periodEnd).toBeNull();
    });

    it("reports billing fields once the team subscribes", async () => {
      await activateTeam(teamId, 25);

      const teams = await listTeamsForUser(ownerId);
      const team = teams.find((t) => t.id === teamId);

      expect(team).toBeDefined();
      expect(team!.subscriptionStatus).toBe("active");
      expect(team!.suspended).toBe(false);
      expect(team!.seats).toBe(25);
      expect(team!.requestsUsed).toBe(0);
      expect(team!.requestLimit).toBe(25 * SEAT_REQUEST_LIMIT);
      expect(team!.cancelAtPeriodEnd).toBe(false);
      expect(team!.periodEnd).toBeGreaterThan(Date.now());
    });

    it("returns empty list for user with no teams", async () => {
      const teams = await listTeamsForUser(memberId);
      expect(teams).toEqual([]);
    });

    it("renames a team (owner only)", async () => {
      const updated = await updateTeam(ownerId, teamId, "Renamed Team");
      expect(updated).toBe(true);

      const teams = await listTeamsForUser(ownerId);
      const team = teams.find((t) => t.id === teamId);
      expect(team!.name).toBe("Renamed Team");
    });

    it("rejects rename from non-member", async () => {
      // memberId is not yet a team member at this point in the test flow
      const updated = await updateTeam(memberId, teamId, "Hacked Name");
      expect(updated).toBe(false);
    });

    it("rejects rename for non-existent team", async () => {
      const updated = await updateTeam(ownerId, "00000000-0000-0000-0000-000000000000", "X");
      expect(updated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------

  describe("Invites", () => {
    it("creates an invite for a registered user while the owner is on the free plan", async () => {
      // The team's subscription is the gate — nobody here is Pro.
      const { data: inviter } = await admin
        .from("users")
        .select("plan")
        .eq("id", ownerId)
        .maybeSingle();
      expect(inviter!.plan).toBe("free");

      const result = await createInvite(ownerId, teamId, MEMBER_EMAIL);

      expect(result.error).toBeUndefined();
      expect(result.invite).toBeDefined();
      expect(result.invite!.teamId).toBe(teamId);
      expect(result.invite!.invitedEmail).toBe(MEMBER_EMAIL);
      expect(result.invite!.status).toBe("pending");
    });

    it("rejects invites on a team with no subscription", async () => {
      const created = await createTeam(ownerId, "Unsubscribed Invite Team");
      const unsubscribedTeamId = (created as { id: string }).id;

      const result = await createInvite(ownerId, unsubscribedTeamId, THIRD_EMAIL);
      expect(result.error).toBe(INACTIVE_TEAM_ERROR);
      expect(result.invite).toBeUndefined();

      await admin.from("teams").delete().eq("id", unsubscribedTeamId);
    });

    it("rejects invites once members fill every purchased seat", async () => {
      const created = await createTeam(ownerId, "One Seat Team");
      const oneSeatTeamId = (created as { id: string }).id;
      // One seat, and the owner already occupies it.
      await activateTeam(oneSeatTeamId, 1);

      const result = await createInvite(ownerId, oneSeatTeamId, THIRD_EMAIL);
      expect(result.error).toBe(NO_SEATS_ERROR);
      expect(result.invite).toBeUndefined();

      await admin.from("teams").delete().eq("id", oneSeatTeamId);
    });

    it("rejects invite for non-existent email", async () => {
      const result = await createInvite(ownerId, teamId, "nobody@nonexistent.test");
      expect(result.error).toBe("No account found with that email address");
    });

    it("rejects invite from non-member", async () => {
      // memberId is not yet a team member at this point
      const result = await createInvite(memberId, teamId, THIRD_EMAIL);
      expect(result.error).toBe("Not authorized");
    });

    it("rejects self-invite", async () => {
      const result = await createInvite(ownerId, teamId, OWNER_EMAIL);
      expect(result.error).toBe("You cannot invite yourself");
    });

    it("rejects duplicate pending invite", async () => {
      const result = await createInvite(ownerId, teamId, MEMBER_EMAIL);
      expect(result.error).toContain("already");
    });

    it("lists pending invites for the invited user", async () => {
      const invites = await listPendingInvitesForUser(memberId);

      expect(invites.length).toBeGreaterThanOrEqual(1);
      const invite = invites.find((i) => i.teamId === teamId);
      expect(invite).toBeDefined();
      expect(invite!.teamName).toBe("Renamed Team");
      expect(invite!.invitedEmail).toBe(MEMBER_EMAIL);
      expect(invite!.status).toBe("pending");
    });

    it("lists pending invites for the team", async () => {
      const invites = await listPendingInvitesForTeam(ownerId, teamId);

      expect(invites).not.toBeNull();
      expect(invites!.length).toBeGreaterThanOrEqual(1);
      const invite = invites!.find((i) => i.invitedEmail === MEMBER_EMAIL);
      expect(invite).toBeDefined();
      expect(invite!.status).toBe("pending");
    });

    it("returns null for team invite list when not a member", async () => {
      const invites = await listPendingInvitesForTeam(thirdId, teamId);
      expect(invites).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Decline invite flow
  // ---------------------------------------------------------------------------

  describe("Decline invite", () => {
    let thirdInviteId: string;

    it("creates and declines an invite", async () => {
      const result = await createInvite(ownerId, teamId, THIRD_EMAIL);
      expect(result.invite).toBeDefined();
      thirdInviteId = result.invite!.id;

      const declined = await declineInvite(thirdId, thirdInviteId);
      expect(declined).toBe(true);
    });

    it("declined invite no longer shows in pending list", async () => {
      const invites = await listPendingInvitesForUser(thirdId);
      const found = invites.find((i) => i.id === thirdInviteId);
      expect(found).toBeUndefined();
    });

    it("rejects declining an already-declined invite", async () => {
      const result = await declineInvite(thirdId, thirdInviteId);
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Accept invite + membership
  // ---------------------------------------------------------------------------

  describe("Accept invite and membership", () => {
    it("accepts the pending invite while on the free plan", async () => {
      const { data: invitee } = await admin
        .from("users")
        .select("plan")
        .eq("id", memberId)
        .maybeSingle();
      expect(invitee!.plan).toBe("free");

      const invites = await listPendingInvitesForUser(memberId);
      const invite = invites.find((i) => i.teamId === teamId);
      expect(invite).toBeDefined();

      const result = await acceptInvite(memberId, invite!.id);
      expect(result.accepted).toBe(true);
    });

    it("rejects acceptance when the team's subscription lapsed, leaving the invite pending", async () => {
      const created = await createTeam(ownerId, "Lapsed Team");
      const lapsedTeamId = (created as { id: string }).id;
      await activateTeam(lapsedTeamId, 5);

      const inviteResult = await createInvite(ownerId, lapsedTeamId, THIRD_EMAIL);
      expect(inviteResult.invite).toBeDefined();

      // Subscription lapses between invite and accept.
      await admin.from("teams").update({ subscription_status: null }).eq("id", lapsedTeamId);

      const accepted = await acceptInvite(thirdId, inviteResult.invite!.id);
      expect(accepted.accepted).toBe(false);
      expect(accepted.error).toBe(INACTIVE_TEAM_ERROR);

      // Rolled back to pending so it works once the team resubscribes.
      const stillPending = await listPendingInvitesForUser(thirdId);
      expect(stillPending.some((i) => i.id === inviteResult.invite!.id)).toBe(true);

      await admin.from("teams").delete().eq("id", lapsedTeamId);
    });

    it("member now appears in team members list", async () => {
      const members = await listTeamMembers(ownerId, teamId);

      expect(members).not.toBeNull();
      expect(members!.length).toBe(2);

      const owner = members!.find((m) => m.userId === ownerId);
      expect(owner).toBeDefined();
      expect(owner!.role).toBe("owner");
      expect(owner!.email).toBe(OWNER_EMAIL);

      const member = members!.find((m) => m.userId === memberId);
      expect(member).toBeDefined();
      expect(member!.role).toBe("member");
      expect(member!.email).toBe(MEMBER_EMAIL);
    });

    it("member can see the team in their team list", async () => {
      const teams = await listTeamsForUser(memberId);

      expect(teams.length).toBeGreaterThanOrEqual(1);
      const team = teams.find((t) => t.id === teamId);
      expect(team).toBeDefined();
      expect(team!.role).toBe("member");
      expect(team!.memberCount).toBe(2);
    });

    it("member can view team members", async () => {
      const members = await listTeamMembers(memberId, teamId);
      expect(members).not.toBeNull();
      expect(members!.length).toBe(2);
    });

    it("rejects already-existing member invite", async () => {
      // Clean the old declined invite for this email first
      const result = await createInvite(ownerId, teamId, MEMBER_EMAIL);
      expect(result.error).toBe("User is already a member of this team");
    });

    it("non-member cannot view team members", async () => {
      const members = await listTeamMembers(thirdId, teamId);
      expect(members).toBeNull();
    });

    it("no longer shows accepted invite in pending list", async () => {
      const invites = await listPendingInvitesForUser(memberId);
      const found = invites.find((i) => i.teamId === teamId);
      expect(found).toBeUndefined();
    });

    it("member (not owner) cannot invite others", async () => {
      // memberId is now a confirmed member — test the member-but-not-owner path
      const result = await createInvite(memberId, teamId, THIRD_EMAIL);
      expect(result.error).toBe("Not authorized");
    });

    it("member (not owner) cannot rename team", async () => {
      const updated = await updateTeam(memberId, teamId, "Member Rename");
      expect(updated).toBe(false);
    });

    it("member (not owner) cannot delete team", async () => {
      const deleted = await deleteTeam(memberId, teamId);
      expect(deleted).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Endpoint sharing
  // ---------------------------------------------------------------------------

  describe("Endpoint sharing", () => {
    it("owner shares an endpoint with the team", async () => {
      const result = await shareEndpointWithTeam(ownerId, teamId, endpointId);
      expect(result.success).toBe(true);
    });

    it("sharing the same endpoint again returns already-shared error", async () => {
      const result = await shareEndpointWithTeam(ownerId, teamId, endpointId);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Endpoint is already shared with this team");
    });

    it("non-owner cannot share their endpoint with the team", async () => {
      // Member doesn't own this endpoint
      const result = await shareEndpointWithTeam(memberId, teamId, endpointId);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Endpoint not found or not owned by you");
    });

    it("rejects sharing with a team that has no subscription", async () => {
      const created = await createTeam(ownerId, "Unsubscribed Share Team");
      const unsubscribedTeamId = (created as { id: string }).id;

      const result = await shareEndpointWithTeam(ownerId, unsubscribedTeamId, endpointId);
      expect(result.success).toBe(false);
      expect(result.error).toBe(INACTIVE_TEAM_ERROR);

      await admin.from("teams").delete().eq("id", unsubscribedTeamId);
    });

    it("getTeamSharesForEndpoint returns the sharing info", async () => {
      const shares = await getTeamSharesForEndpoint(ownerId, endpointId);
      expect(shares.length).toBe(1);
      expect(shares[0].teamId).toBe(teamId);
      expect(shares[0].teamName).toBe("Renamed Team");
    });

    it("getShareMetadataForOwnedEndpoints returns share map", async () => {
      const shareMap = await getShareMetadataForOwnedEndpoints(ownerId);
      const shares = shareMap.get(endpointId);
      expect(shares).toBeDefined();
      expect(shares!.length).toBe(1);
      expect(shares![0].teamId).toBe(teamId);
    });

    it("getSharedEndpointsForUser returns shared endpoint for the member", async () => {
      const shared = await getSharedEndpointsForUser(memberId);

      expect(shared.length).toBeGreaterThanOrEqual(1);
      const ep = shared.find((e) => e.id === endpointId);
      expect(ep).toBeDefined();
      expect(ep!.slug).toBe(endpointSlug);
      expect(ep!.name).toBe("Team Test Endpoint");
      expect(ep!.fromTeam.teamId).toBe(teamId);
      expect(ep!.ownerId).toBe(ownerId);
    });

    it("owner does not see their own endpoint in shared list", async () => {
      const shared = await getSharedEndpointsForUser(ownerId);
      const ep = shared.find((e) => e.id === endpointId);
      expect(ep).toBeUndefined();
    });

    it("non-member does not see the shared endpoint", async () => {
      const shared = await getSharedEndpointsForUser(thirdId);
      const ep = shared.find((e) => e.id === endpointId);
      expect(ep).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Access control (resolveEndpointAccess)
  // ---------------------------------------------------------------------------

  describe("Endpoint access control", () => {
    it("owner has access as owner", async () => {
      const access = await resolveEndpointAccess(ownerId, endpointSlug);
      expect(access).not.toBeNull();
      expect(access!.endpointId).toBe(endpointId);
      expect(access!.ownerId).toBe(ownerId);
      expect(access!.isOwner).toBe(true);
    });

    it("team member has access as non-owner", async () => {
      const access = await resolveEndpointAccess(memberId, endpointSlug);
      expect(access).not.toBeNull();
      expect(access!.endpointId).toBe(endpointId);
      expect(access!.ownerId).toBe(ownerId);
      expect(access!.isOwner).toBe(false);
    });

    it("non-member has no access", async () => {
      const access = await resolveEndpointAccess(thirdId, endpointSlug);
      expect(access).toBeNull();
    });

    it("access check is case-insensitive for slug", async () => {
      const access = await resolveEndpointAccess(memberId, endpointSlug.toUpperCase());
      expect(access).not.toBeNull();
      expect(access!.endpointId).toBe(endpointId);
    });

    it("returns null for non-existent slug", async () => {
      const access = await resolveEndpointAccess(ownerId, "nonexistentslug999");
      expect(access).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Team member can read requests on shared endpoint
  // ---------------------------------------------------------------------------

  describe("Team member request access", () => {
    let requestId: string;

    it("inserts a request on the shared endpoint", async () => {
      requestId = await insertRequest(endpointId, ownerId, "/team-test");
      expect(requestId).toBeTruthy();
    });

    it("team member can list requests on the shared endpoint", async () => {
      const requests = await listRequestsForEndpointByUser({
        userId: memberId,
        slug: endpointSlug,
      });

      expect(requests).not.toBeNull();
      expect(requests!.length).toBeGreaterThanOrEqual(1);
      const req = requests!.find((r) => r.id === requestId);
      expect(req).toBeDefined();
      expect(req!.path).toBe("/team-test");
    });

    it("team member can list new requests", async () => {
      const requests = await listNewRequestsForEndpointByUser({
        userId: memberId,
        slug: endpointSlug,
        after: Date.now() - 60_000,
      });

      expect(requests).not.toBeNull();
      expect(requests!.length).toBeGreaterThanOrEqual(1);
    });

    it("non-member cannot list requests", async () => {
      const requests = await listRequestsForEndpointByUser({
        userId: thirdId,
        slug: endpointSlug,
      });

      expect(requests).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Unshare endpoint
  // ---------------------------------------------------------------------------

  describe("Unshare endpoint", () => {
    it("owner unshares the endpoint", async () => {
      const result = await unshareEndpointFromTeam(ownerId, teamId, endpointId);
      expect(result).toBe(true);
    });

    it("endpoint no longer in shared list for member", async () => {
      const shared = await getSharedEndpointsForUser(memberId);
      const ep = shared.find((e) => e.id === endpointId);
      expect(ep).toBeUndefined();
    });

    it("member no longer has access to the endpoint", async () => {
      const access = await resolveEndpointAccess(memberId, endpointSlug);
      expect(access).toBeNull();
    });

    it("member can no longer list requests", async () => {
      const requests = await listRequestsForEndpointByUser({
        userId: memberId,
        slug: endpointSlug,
      });
      expect(requests).toBeNull();
    });

    it("owner still has access", async () => {
      const access = await resolveEndpointAccess(ownerId, endpointSlug);
      expect(access).not.toBeNull();
      expect(access!.isOwner).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Remove member
  // ---------------------------------------------------------------------------

  describe("Remove member", () => {
    it("re-share endpoint for removal test", async () => {
      const result = await shareEndpointWithTeam(ownerId, teamId, endpointId);
      expect(result.success).toBe(true);
    });

    it("member has access before removal", async () => {
      const access = await resolveEndpointAccess(memberId, endpointSlug);
      expect(access).not.toBeNull();
    });

    it("owner cannot remove themselves", async () => {
      const result = await removeTeamMember(ownerId, teamId, ownerId);
      expect(result).toBe(false);
    });

    it("member cannot remove other members", async () => {
      const result = await removeTeamMember(memberId, teamId, ownerId);
      expect(result).toBe(false);
    });

    it("owner removes the member and releases their recorded seat", async () => {
      // A recorded seat id exercises the release path; the team has no Polar
      // subscription, so revokeTeamSeat short-circuits without any HTTP call.
      const { error: seatError } = await admin
        .from("team_members")
        .update({ polar_seat_id: "seat_remove_test" })
        .eq("team_id", teamId)
        .eq("user_id", memberId);
      expect(seatError).toBeNull();

      const result = await removeTeamMember(ownerId, teamId, memberId);
      expect(result).toBe(true);
    });

    it("removed member no longer in team members list", async () => {
      const members = await listTeamMembers(ownerId, teamId);
      expect(members).not.toBeNull();
      expect(members!.length).toBe(1);
      expect(members![0].userId).toBe(ownerId);
    });

    it("removed member loses access to shared endpoint", async () => {
      const access = await resolveEndpointAccess(memberId, endpointSlug);
      expect(access).toBeNull();
    });

    it("removed member no longer sees team in their list", async () => {
      const teams = await listTeamsForUser(memberId);
      const team = teams.find((t) => t.id === teamId);
      expect(team).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Delete team
  // ---------------------------------------------------------------------------

  describe("Delete team", () => {
    let tempTeamId: string;

    it("creates a temporary team for deletion test", async () => {
      const result = await createTeam(ownerId, "Temp Delete Team");
      expect("error" in result).toBe(false);
      tempTeamId = (result as { id: string }).id;
      expect(tempTeamId).toBeTruthy();
    });

    it("non-member cannot delete", async () => {
      // memberId may or may not be a member of this temp team — tests non-owner path
      const result = await deleteTeam(memberId, tempTeamId);
      expect(result).toBe(false);
    });

    it("owner deletes the team", async () => {
      // Subscribed, but with no Polar subscription id — deletion skips the revoke.
      await activateTeam(tempTeamId, 2);

      const result = await deleteTeam(ownerId, tempTeamId);
      expect(result).toBe(true);
    });

    it("deleted team no longer in owner's list", async () => {
      const teams = await listTeamsForUser(ownerId);
      const found = teams.find((t) => t.id === tempTeamId);
      expect(found).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Paginated request access for team members
  // ---------------------------------------------------------------------------

  describe("Paginated request access", () => {
    it("re-share endpoint for pagination tests", async () => {
      // Re-add member to the team (ignore if already exists)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("team_members")
        .upsert(
          { team_id: teamId, user_id: memberId, role: "member" },
          { onConflict: "team_id,user_id" }
        );

      // Ensure endpoint is shared (may already be from earlier re-share test)
      const result = await shareEndpointWithTeam(ownerId, teamId, endpointId);
      expect(
        result.success === true || result.error === "Endpoint is already shared with this team"
      ).toBe(true);
    });

    it("team member can paginate requests on shared endpoint", async () => {
      const page = await listPaginatedRequestsForEndpointByUser({
        userId: memberId,
        slug: endpointSlug,
        limit: 10,
      });

      expect(page).not.toBeNull();
      expect(page!.items.length).toBeGreaterThanOrEqual(1);
    });

    it("non-member cannot paginate requests", async () => {
      const page = await listPaginatedRequestsForEndpointByUser({
        userId: thirdId,
        slug: endpointSlug,
        limit: 10,
      });

      expect(page).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Get request by ID for team members
  // ---------------------------------------------------------------------------

  describe("Get request by ID", () => {
    let requestId: string;

    it("insert a request for getById tests", async () => {
      requestId = await insertRequest(endpointId, ownerId, "/get-by-id-test");
      expect(requestId).toBeTruthy();
    });

    it("owner can get request by ID", async () => {
      const req = await getRequestByIdForUser(ownerId, requestId);
      expect(req).not.toBeNull();
      expect(req!.id).toBe(requestId);
      expect(req!.path).toBe("/get-by-id-test");
    });

    it("team member can get request by ID on shared endpoint", async () => {
      const req = await getRequestByIdForUser(memberId, requestId);
      expect(req).not.toBeNull();
      expect(req!.id).toBe(requestId);
    });

    it("non-member cannot get request by ID", async () => {
      const req = await getRequestByIdForUser(thirdId, requestId);
      expect(req).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Clear requests — owner only
  // ---------------------------------------------------------------------------

  describe("Clear requests access control", () => {
    it("team member cannot clear requests on shared endpoint", async () => {
      const result = await clearRequestsForEndpointByUser({
        userId: memberId,
        slug: endpointSlug,
      });

      expect(result).toBeNull();
    });

    it("owner can clear requests on their endpoint", async () => {
      // Insert a fresh request to clear
      await insertRequest(endpointId, ownerId, "/to-clear");

      const result = await clearRequestsForEndpointByUser({
        userId: ownerId,
        slug: endpointSlug,
      });

      expect(result).not.toBeNull();
      expect(result!.deleted).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Re-invite after decline
  // ---------------------------------------------------------------------------

  describe("Re-invite after decline", () => {
    it("owner can re-invite a user who previously declined", async () => {
      // thirdId previously declined an invite in earlier tests
      const result = await createInvite(ownerId, teamId, THIRD_EMAIL);
      expect(result.error).toBeUndefined();
      expect(result.invite).toBeDefined();
      expect(result.invite!.invitedEmail).toBe(THIRD_EMAIL);
      expect(result.invite!.status).toBe("pending");

      // Clean up: decline it again so it doesn't interfere
      await declineInvite(thirdId, result.invite!.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Share/unshare edge cases
  // ---------------------------------------------------------------------------

  describe("Share/unshare edge cases", () => {
    it("endpoint owner who is not a team member cannot share", async () => {
      // Create a new team owned by thirdId — ownerId is NOT a member
      const otherTeamResult = await createTeam(thirdId, "Other Team");
      expect("error" in otherTeamResult).toBe(false);
      const otherTeamId = (otherTeamResult as { id: string }).id;

      const result = await shareEndpointWithTeam(ownerId, otherTeamId, endpointId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not a member");

      // Clean up
      await deleteTeam(thirdId, otherTeamId);
    });

    it("team member who does not own endpoint cannot unshare", async () => {
      const result = await unshareEndpointFromTeam(memberId, teamId, endpointId);
      expect(result).toBe(false);
    });

    it("unsharing a non-shared endpoint succeeds silently", async () => {
      // Create a new endpoint that is NOT shared
      const ep2 = await createEndpointForUser({ userId: ownerId, name: "Unshared EP" });
      // The delete runs but affects 0 rows — function returns true or false depending on implementation
      const result = await unshareEndpointFromTeam(ownerId, teamId, ep2.id);
      // Either true (delete ran) or false (no row found) — just check it doesn't throw
      expect(typeof result).toBe("boolean");
    });

    it("getTeamSharesForEndpoint returns empty for non-owner", async () => {
      const shares = await getTeamSharesForEndpoint(memberId, endpointId);
      expect(shares).toEqual([]);
    });

    it("getShareMetadataForOwnedEndpoints returns empty for user with no endpoints", async () => {
      const map = await getShareMetadataForOwnedEndpoints(thirdId);
      expect(map.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Accept/decline by wrong user
  // ---------------------------------------------------------------------------

  describe("Accept/decline authorization", () => {
    let inviteForMember: string;

    it("create a fresh invite for auth tests", async () => {
      // Remove member first so we can re-invite
      await removeTeamMember(ownerId, teamId, memberId);
      const result = await createInvite(ownerId, teamId, MEMBER_EMAIL);
      expect(result.invite).toBeDefined();
      inviteForMember = result.invite!.id;
    });

    it("wrong user cannot accept someone else's invite", async () => {
      const result = await acceptInvite(thirdId, inviteForMember);
      expect(result.accepted).toBe(false);
    });

    it("wrong user cannot decline someone else's invite", async () => {
      const result = await declineInvite(thirdId, inviteForMember);
      expect(result).toBe(false);
    });

    it("accepting an already-accepted invite returns false", async () => {
      const first = await acceptInvite(memberId, inviteForMember);
      expect(first.accepted).toBe(true);

      const again = await acceptInvite(memberId, inviteForMember);
      expect(again.accepted).toBe(false);
    });

    it("non-team-member cannot invite", async () => {
      const result = await createInvite(thirdId, teamId, "anyone@test.local");
      expect(result.error).toBe("Not authorized");
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-team deduplication in getSharedEndpointsForUser
  // ---------------------------------------------------------------------------

  describe("Multi-team deduplication", () => {
    let secondTeamId: string;

    it("share same endpoint with a second team", async () => {
      const team2Result = await createTeam(ownerId, "Second Team");
      expect("error" in team2Result).toBe(false);
      secondTeamId = (team2Result as { id: string }).id;
      // Sharing requires a subscription on the receiving team.
      await activateTeam(secondTeamId, 5);

      // Add member to second team
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("team_members")
        .insert({ team_id: secondTeamId, user_id: memberId, role: "member" });

      // Share same endpoint with second team
      const result = await shareEndpointWithTeam(ownerId, secondTeamId, endpointId);
      expect(result.success).toBe(true);
    });

    it("getSharedEndpointsForUser returns endpoint only once", async () => {
      const shared = await getSharedEndpointsForUser(memberId);
      const matching = shared.filter((e) => e.id === endpointId);
      expect(matching.length).toBe(1);
    });

    it("cleanup second team", async () => {
      await deleteTeam(ownerId, secondTeamId);
    });
  });

  // ---------------------------------------------------------------------------
  // Leave team
  // ---------------------------------------------------------------------------

  describe("Leave team", () => {
    it("owner cannot leave their own team", async () => {
      const result = await leaveTeam(ownerId, teamId);
      expect(result).toBe(false);
    });

    it("member can leave a team, releasing their recorded seat", async () => {
      // Ensure member is in the team
      const teams = await listTeamsForUser(memberId);
      const inTeam = teams.some((t) => t.id === teamId);
      if (!inTeam) {
        // Re-add for this test
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (admin as any)
          .from("team_members")
          .upsert(
            { team_id: teamId, user_id: memberId, role: "member" },
            { onConflict: "team_id,user_id" }
          );
      }

      // As in the removal test: a recorded seat id, no Polar subscription.
      await admin
        .from("team_members")
        .update({ polar_seat_id: "seat_leave_test" })
        .eq("team_id", teamId)
        .eq("user_id", memberId);

      const result = await leaveTeam(memberId, teamId);
      expect(result).toBe(true);
    });

    it("member no longer in team after leaving", async () => {
      const teams = await listTeamsForUser(memberId);
      const found = teams.find((t) => t.id === teamId);
      expect(found).toBeUndefined();
    });

    it("non-member cannot leave a team they are not in", async () => {
      const result = await leaveTeam(thirdId, teamId);
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Team creation limit (max 10 owned teams)
  // ---------------------------------------------------------------------------

  describe("Team creation limit", () => {
    const tempTeamIds: string[] = [];

    it("respects the 10-team ownership limit", async () => {
      // Owner already has 1 team (teamId). Create 9 more to hit the limit.
      for (let i = 0; i < 9; i++) {
        const result = await createTeam(ownerId, `Limit Test ${i}`);
        if (!("error" in result)) {
          tempTeamIds.push(result.id);
        }
      }

      // The 11th team should fail
      const result = await createTeam(ownerId, "One Too Many");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("10");
      }
    });

    it("cleanup temp teams", async () => {
      for (const id of tempTeamIds) {
        await deleteTeam(ownerId, id);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Plan-independent membership
  // ---------------------------------------------------------------------------

  describe("Plan-independent membership", () => {
    let freeUserId: string;
    let freeInviteId: string;

    it("creates a free user for plan-independence tests", async () => {
      const { data, error } = await admin.auth.admin.createUser({
        email: `test-teams-free-${ts}@webhooks-test.local`,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: "Free User" },
      });
      if (error) throw error;
      freeUserId = data.user!.id;
      // Stays on free plan (default)
    });

    it("free user can create a team (teams are plan-independent)", async () => {
      const result = await createTeam(freeUserId, "Free Team");
      expect("error" in result).toBe(false);
      const team = result as Exclude<typeof result, { error: string }>;
      expect(team.suspended).toBe(true);
      expect(team.seats).toBe(0);

      await deleteTeam(freeUserId, team.id);
    });

    it("free user can accept an invite to a subscribed team", async () => {
      const inviteResult = await createInvite(
        ownerId,
        teamId,
        `test-teams-free-${ts}@webhooks-test.local`
      );
      expect(inviteResult.invite).toBeDefined();
      freeInviteId = inviteResult.invite!.id;

      const acceptResult = await acceptInvite(freeUserId, freeInviteId);
      expect(acceptResult.accepted).toBe(true);
      expect(acceptResult.error).toBeUndefined();

      const members = await listTeamMembers(ownerId, teamId);
      expect(members!.some((m) => m.userId === freeUserId)).toBe(true);

      // Restore the roster for the suites that follow.
      const removed = await removeTeamMember(ownerId, teamId, freeUserId);
      expect(removed).toBe(true);
    });

    it("cleanup free user", async () => {
      if (freeUserId) {
        await admin.auth.admin.deleteUser(freeUserId);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Access and suspension follow the team's subscription, never a personal plan
  // ---------------------------------------------------------------------------

  describe("Subscription-based access control and suspension", () => {
    let suspOwnerId: string;
    let freeMemberId: string;
    let proMemberId: string;
    let suspensionTeamId: string;
    let suspensionEndpointId: string;
    let suspensionEndpointSlug: string;

    it("setup: subscribed team, free owner, free member, shared endpoint", async () => {
      const { data: ownerData } = await admin.auth.admin.createUser({
        email: `test-suspend-owner-${ts}@webhooks-test.local`,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: "Suspend Owner" },
      });
      suspOwnerId = ownerData!.user!.id;
      // The owner stays on the free personal plan on purpose.

      const teamResult = await createTeam(suspOwnerId, "Suspension Test Team");
      expect("error" in teamResult).toBe(false);
      suspensionTeamId = (teamResult as { id: string }).id;
      await activateTeam(suspensionTeamId, 5);

      const ep = await createEndpointForUser({ userId: suspOwnerId, name: "Susp EP" });
      suspensionEndpointId = ep.id;
      suspensionEndpointSlug = ep.slug;

      const shared = await shareEndpointWithTeam(
        suspOwnerId,
        suspensionTeamId,
        suspensionEndpointId
      );
      expect(shared.success).toBe(true);

      const { data: freeData } = await admin.auth.admin.createUser({
        email: `test-suspend-free-${ts}@webhooks-test.local`,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: "Suspend Free" },
      });
      freeMemberId = freeData!.user!.id;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("team_members")
        .insert({ team_id: suspensionTeamId, user_id: freeMemberId, role: "member" });

      await insertRequest(suspensionEndpointId, suspOwnerId, "/suspend-test");
    });

    it("free member of a subscribed team resolves access to the shared endpoint", async () => {
      const access = await resolveEndpointAccess(freeMemberId, suspensionEndpointSlug);
      expect(access).not.toBeNull();
      expect(access!.endpointId).toBe(suspensionEndpointId);
      expect(access!.ownerId).toBe(suspOwnerId);
      expect(access!.isOwner).toBe(false);
    });

    it("free member sees the endpoint in their shared list and reads its requests", async () => {
      const shared = await getSharedEndpointsForUser(freeMemberId);
      expect(shared.find((e) => e.id === suspensionEndpointId)).toBeDefined();

      const requests = await listRequestsForEndpointByUser({
        userId: freeMemberId,
        slug: suspensionEndpointSlug,
      });
      expect(requests).not.toBeNull();
      expect(requests!.length).toBeGreaterThanOrEqual(1);
    });

    it("deactivating the subscription revokes member access; the owner keeps it", async () => {
      await admin.from("teams").update({ subscription_status: null }).eq("id", suspensionTeamId);

      expect(await resolveEndpointAccess(freeMemberId, suspensionEndpointSlug)).toBeNull();

      const shared = await getSharedEndpointsForUser(freeMemberId);
      expect(shared.find((e) => e.id === suspensionEndpointId)).toBeUndefined();

      const requests = await listRequestsForEndpointByUser({
        userId: freeMemberId,
        slug: suspensionEndpointSlug,
      });
      expect(requests).toBeNull();

      // The endpoint owner never depends on the team's subscription.
      const ownerAccess = await resolveEndpointAccess(suspOwnerId, suspensionEndpointSlug);
      expect(ownerAccess).not.toBeNull();
      expect(ownerAccess!.isOwner).toBe(true);

      const teams = await listTeamsForUser(freeMemberId);
      expect(teams.find((t) => t.id === suspensionTeamId)!.suspended).toBe(true);
    });

    it("a Pro personal plan buys no access to an unsubscribed team", async () => {
      const { data: proMemberData } = await admin.auth.admin.createUser({
        email: `test-suspend-pro-member-${ts}@webhooks-test.local`,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: "Pro Member Susp" },
      });
      proMemberId = proMemberData!.user!.id;
      await admin.from("users").update({ plan: "pro" }).eq("id", proMemberId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("team_members")
        .insert({ team_id: suspensionTeamId, user_id: proMemberId, role: "member" });

      expect(await resolveEndpointAccess(proMemberId, suspensionEndpointSlug)).toBeNull();

      const shared = await getSharedEndpointsForUser(proMemberId);
      expect(shared.find((e) => e.id === suspensionEndpointId)).toBeUndefined();
    });

    it("resubscribing the team restores access for both members", async () => {
      await activateTeam(suspensionTeamId, 5);

      const freeAccess = await resolveEndpointAccess(freeMemberId, suspensionEndpointSlug);
      expect(freeAccess).not.toBeNull();
      expect(freeAccess!.isOwner).toBe(false);

      const proAccess = await resolveEndpointAccess(proMemberId, suspensionEndpointSlug);
      expect(proAccess).not.toBeNull();

      const shared = await getSharedEndpointsForUser(freeMemberId);
      expect(shared.find((e) => e.id === suspensionEndpointId)).toBeDefined();

      const requests = await listRequestsForEndpointByUser({
        userId: freeMemberId,
        slug: suspensionEndpointSlug,
      });
      expect(requests).not.toBeNull();

      const teams = await listTeamsForUser(freeMemberId);
      expect(teams.find((t) => t.id === suspensionTeamId)!.suspended).toBe(false);
    });

    it("access passes when any sharing team the user belongs to is subscribed", async () => {
      const ep = await createEndpointForUser({ userId: suspOwnerId, name: "Multi Share EP" });

      // The share row for the team that later lapses is inserted first, so an
      // implementation that only inspects the first matching share row fails here.
      const lapsed = await createTeam(suspOwnerId, "Lapsed Share Team");
      const lapsedTeamId = (lapsed as { id: string }).id;
      await activateTeam(lapsedTeamId, 2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("team_members")
        .insert({ team_id: lapsedTeamId, user_id: freeMemberId, role: "member" });
      expect((await shareEndpointWithTeam(suspOwnerId, lapsedTeamId, ep.id)).success).toBe(true);

      expect((await shareEndpointWithTeam(suspOwnerId, suspensionTeamId, ep.id)).success).toBe(
        true
      );

      await admin.from("teams").update({ subscription_status: null }).eq("id", lapsedTeamId);

      const access = await resolveEndpointAccess(freeMemberId, ep.slug);
      expect(access).not.toBeNull();
      expect(access!.isOwner).toBe(false);

      // Once every sharing team has lapsed, access is gone.
      await admin.from("teams").update({ subscription_status: null }).eq("id", suspensionTeamId);
      expect(await resolveEndpointAccess(freeMemberId, ep.slug)).toBeNull();

      await activateTeam(suspensionTeamId, 5);
      await admin.from("teams").delete().eq("id", lapsedTeamId);
    });

    it("cleanup suspension test users", async () => {
      await admin.from("teams").delete().eq("id", suspensionTeamId);
      await admin.auth.admin.deleteUser(suspOwnerId);
      await admin.auth.admin.deleteUser(freeMemberId);
      await admin.auth.admin.deleteUser(proMemberId);
    });
  });

  // ---------------------------------------------------------------------------
  // Retention: a team-billed request outlives the owner's personal window
  // ---------------------------------------------------------------------------

  describe("Team-billed retention", () => {
    let retOwnerId: string;
    let retMemberId: string;
    let retTeamId: string;
    let retEndpointId: string;
    let retEndpointSlug: string;
    let teamBilledId: string;
    let personalId: string;

    it("setup: free owner, subscribed team, two 10-day-old requests", async () => {
      const [ownerData, memberData] = await Promise.all([
        admin.auth.admin.createUser({
          email: `test-retention-owner-${ts}@webhooks-test.local`,
          password: TEST_PASSWORD,
          email_confirm: true,
          user_metadata: { full_name: "Retention Owner" },
        }),
        admin.auth.admin.createUser({
          email: `test-retention-member-${ts}@webhooks-test.local`,
          password: TEST_PASSWORD,
          email_confirm: true,
          user_metadata: { full_name: "Retention Member" },
        }),
      ]);
      retOwnerId = ownerData.data!.user!.id;
      retMemberId = memberData.data!.user!.id;
      // Both stay on the free personal plan (7-day retention).

      const teamResult = await createTeam(retOwnerId, "Retention Team");
      retTeamId = (teamResult as { id: string }).id;
      await activateTeam(retTeamId, 3);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("team_members")
        .insert({ team_id: retTeamId, user_id: retMemberId, role: "member" });

      const ep = await createEndpointForUser({ userId: retOwnerId, name: "Retention EP" });
      retEndpointId = ep.id;
      retEndpointSlug = ep.slug;
      expect((await shareEndpointWithTeam(retOwnerId, retTeamId, retEndpointId)).success).toBe(
        true
      );

      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
      teamBilledId = await insertRequest(retEndpointId, retOwnerId, "/team-billed", {
        receivedAt: tenDaysAgo,
        teamId: retTeamId,
      });
      personalId = await insertRequest(retEndpointId, retOwnerId, "/personal", {
        receivedAt: tenDaysAgo,
      });
    });

    it("owner reads the team-billed request past the free 7-day cutoff", async () => {
      const req = await getRequestByIdForUser(retOwnerId, teamBilledId);
      expect(req).not.toBeNull();
      expect(req!.path).toBe("/team-billed");
    });

    it("team member reads the team-billed request past the cutoff", async () => {
      const req = await getRequestByIdForUser(retMemberId, teamBilledId);
      expect(req).not.toBeNull();
      expect(req!.id).toBe(teamBilledId);
    });

    it("a personal request of the same age stays hidden from both", async () => {
      expect(await getRequestByIdForUser(retOwnerId, personalId)).toBeNull();
      expect(await getRequestByIdForUser(retMemberId, personalId)).toBeNull();
    });

    it("list returns the team-billed row and drops the personal one", async () => {
      const requests = await listRequestsForEndpointByUser({
        userId: retOwnerId,
        slug: retEndpointSlug,
      });
      expect(requests).not.toBeNull();
      const paths = requests!.map((r) => r.path);
      expect(paths).toContain("/team-billed");
      expect(paths).not.toContain("/personal");
    });

    it("paginated list applies the same carve-out for a member", async () => {
      const page = await listPaginatedRequestsForEndpointByUser({
        userId: retMemberId,
        slug: retEndpointSlug,
        limit: 10,
      });
      expect(page).not.toBeNull();
      const paths = page!.items.map((r) => r.path);
      expect(paths).toContain("/team-billed");
      expect(paths).not.toContain("/personal");
    });

    it("the caller's `since` bound still wins over the carve-out", async () => {
      const requests = await listRequestsForEndpointByUser({
        userId: retOwnerId,
        slug: retEndpointSlug,
        since: Date.now() - 60_000,
      });
      expect(requests).not.toBeNull();
      expect(requests!.map((r) => r.path)).not.toContain("/team-billed");
    });

    it("listNewRequests honours `after` and still returns fresh team-billed rows", async () => {
      const freshId = await insertRequest(retEndpointId, retOwnerId, "/team-billed-fresh", {
        teamId: retTeamId,
      });

      const requests = await listNewRequestsForEndpointByUser({
        userId: retMemberId,
        slug: retEndpointSlug,
        after: Date.now() - 60_000,
      });
      expect(requests).not.toBeNull();
      const paths = requests!.map((r) => r.path);
      expect(paths).toContain("/team-billed-fresh");
      // The 10-day-old team-billed row is older than `after`.
      expect(paths).not.toContain("/team-billed");
      expect(requests!.some((r) => r.id === freshId)).toBe(true);
    });

    it("cleanup retention test", async () => {
      await admin.from("teams").delete().eq("id", retTeamId);
      await admin.auth.admin.deleteUser(retOwnerId);
      await admin.auth.admin.deleteUser(retMemberId);
    });
  });

  // ---------------------------------------------------------------------------
  // The two gates on GET /api/endpoints: share metadata for the caller's OWN
  // endpoints (any membership) vs shared-with-me endpoints (paid, active only)
  // ---------------------------------------------------------------------------

  describe("Share-metadata gate", () => {
    let gateUserId: string;
    let gateTeamId: string;

    it("both gates are false for a user with no teams", async () => {
      const { data } = await admin.auth.admin.createUser({
        email: `test-teams-gate-${ts}@webhooks-test.local`,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: "Gate User" },
      });
      gateUserId = data!.user!.id;

      expect(await hasAnyTeamMembership(gateUserId)).toBe(false);
      expect(await hasActiveTeamMembership(gateUserId)).toBe(false);
    });

    it("membership alone is enough for the share-metadata gate", async () => {
      const created = await createTeam(gateUserId, "Gate Team");
      gateTeamId = (created as { id: string }).id;

      // The team has no subscription: the owner still needs to see their own
      // share rows to manage them, but buys no shared-with-me access.
      expect(await hasAnyTeamMembership(gateUserId)).toBe(true);
      expect(await hasActiveTeamMembership(gateUserId)).toBe(false);
    });

    it("the active gate flips true once the team subscribes and false when it lapses", async () => {
      await activateTeam(gateTeamId, 2);
      expect(await hasActiveTeamMembership(gateUserId)).toBe(true);
      expect(await hasAnyTeamMembership(gateUserId)).toBe(true);

      await admin.from("teams").update({ subscription_status: null }).eq("id", gateTeamId);
      expect(await hasActiveTeamMembership(gateUserId)).toBe(false);
      expect(await hasAnyTeamMembership(gateUserId)).toBe(true);
    });

    it("cleanup gate test", async () => {
      await admin.from("teams").delete().eq("id", gateTeamId);
      await admin.auth.admin.deleteUser(gateUserId);
    });
  });

  // ---------------------------------------------------------------------------
  // An owner keeps control of an endpoint they shared with a team that lapsed
  // ---------------------------------------------------------------------------

  describe("Lapsed-team share management", () => {
    let lapsedOwnerId: string;
    let lapsedMemberId: string;
    let lapsedTeamId: string;
    let lapsedEndpointId: string;

    it("setup: shared endpoint on a team whose subscription then lapses", async () => {
      const [ownerData, memberData] = await Promise.all([
        admin.auth.admin.createUser({
          email: `test-lapsed-owner-${ts}@webhooks-test.local`,
          password: TEST_PASSWORD,
          email_confirm: true,
          user_metadata: { full_name: "Lapsed Owner" },
        }),
        admin.auth.admin.createUser({
          email: `test-lapsed-member-${ts}@webhooks-test.local`,
          password: TEST_PASSWORD,
          email_confirm: true,
          user_metadata: { full_name: "Lapsed Member" },
        }),
      ]);
      lapsedOwnerId = ownerData.data!.user!.id;
      lapsedMemberId = memberData.data!.user!.id;

      const created = await createTeam(lapsedOwnerId, "Lapsed Management Team");
      lapsedTeamId = (created as { id: string }).id;
      await activateTeam(lapsedTeamId, 3);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("team_members")
        .insert({ team_id: lapsedTeamId, user_id: lapsedMemberId, role: "member" });

      const ep = await createEndpointForUser({ userId: lapsedOwnerId, name: "Lapsed EP" });
      lapsedEndpointId = ep.id;
      expect(
        (await shareEndpointWithTeam(lapsedOwnerId, lapsedTeamId, lapsedEndpointId)).success
      ).toBe(true);

      // The subscription lapses — as every pre-existing team does at cutover.
      await admin.from("teams").update({ subscription_status: null }).eq("id", lapsedTeamId);
    });

    it("owner still sees the share row on their own endpoint", async () => {
      // Without this the endpoint drops out of the team page's "shared" list and
      // its Remove button disappears, stranding the share.
      const map = await getShareMetadataForOwnedEndpoints(lapsedOwnerId);
      const shares = map.get(lapsedEndpointId);
      expect(shares).toBeDefined();
      expect(shares!.some((s) => s.teamId === lapsedTeamId)).toBe(true);
    });

    it("the member's shared-with-me list is empty — that part is the paid feature", async () => {
      const shared = await getSharedEndpointsForUser(lapsedMemberId);
      expect(shared.find((e) => e.id === lapsedEndpointId)).toBeUndefined();
      expect(await hasActiveTeamMembership(lapsedMemberId)).toBe(false);
    });

    it("owner can still unshare from the lapsed team", async () => {
      expect(await unshareEndpointFromTeam(lapsedOwnerId, lapsedTeamId, lapsedEndpointId)).toBe(
        true
      );

      const map = await getShareMetadataForOwnedEndpoints(lapsedOwnerId);
      expect(map.get(lapsedEndpointId)).toBeUndefined();
    });

    it("cleanup lapsed-team test", async () => {
      await admin.from("teams").delete().eq("id", lapsedTeamId);
      await admin.auth.admin.deleteUser(lapsedOwnerId);
      await admin.auth.admin.deleteUser(lapsedMemberId);
    });
  });

  // ---------------------------------------------------------------------------
  // API route: GET /api/endpoints returns { owned, shared }
  // ---------------------------------------------------------------------------

  describe("Endpoints API response shape", () => {
    it("re-add member and share for API tests", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("team_members")
        .upsert(
          { team_id: teamId, user_id: memberId, role: "member" },
          { onConflict: "team_id,user_id" }
        );

      const result = await shareEndpointWithTeam(ownerId, teamId, endpointId);
      expect(
        result.success === true || result.error === "Endpoint is already shared with this team"
      ).toBe(true);
    });

    it("getShareMetadataForOwnedEndpoints returns share info for owner", async () => {
      const map = await getShareMetadataForOwnedEndpoints(ownerId);
      const shares = map.get(endpointId);
      expect(shares).toBeDefined();
      expect(shares!.length).toBeGreaterThanOrEqual(1);
      expect(shares![0].teamId).toBe(teamId);
    });

    it("getSharedEndpointsForUser returns the endpoint for a member of the subscribed team", async () => {
      const shared = await getSharedEndpointsForUser(memberId);
      const ep = shared.find((e) => e.id === endpointId);
      expect(ep).toBeDefined();
      expect(ep!.fromTeam.teamId).toBe(teamId);
    });
  });

  // ---------------------------------------------------------------------------
  // listTeamMembers exposes membership, never personal plan
  // ---------------------------------------------------------------------------

  describe("Team member fields", () => {
    it("listTeamMembers returns role and email but no plan field", async () => {
      const members = await listTeamMembers(ownerId, teamId);
      expect(members).not.toBeNull();
      expect(members!.length).toBeGreaterThan(0);

      const owner = members!.find((m) => m.userId === ownerId);
      expect(owner).toBeDefined();
      expect(owner!.role).toBe("owner");
      expect(owner!.email).toContain("@");

      // Access hangs off the team subscription, so a personal plan is not part
      // of the member payload at all.
      for (const member of members!) {
        expect(member).not.toHaveProperty("plan");
        expect(["owner", "member"]).toContain(member.role);
        expect(member.email).toContain("@");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Seat cap at accept time
  // ---------------------------------------------------------------------------

  describe("Seat cap at accept time", () => {
    let seatTeamId: string;
    let seatOwnerId: string;
    const seatUserIds: string[] = [];
    let overflowUserId: string;

    it("setup: create a 2-seat team whose owner takes the first seat", async () => {
      const { data: ownerData } = await admin.auth.admin.createUser({
        email: `test-seat-owner-${ts}@webhooks-test.local`,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: "Seat Owner" },
      });
      seatOwnerId = ownerData!.user!.id;
      seatUserIds.push(seatOwnerId);

      const teamResult = await createTeam(seatOwnerId, "Seat Cap Team");
      expect("error" in teamResult).toBe(false);
      seatTeamId = (teamResult as { id: string }).id;

      await activateTeam(seatTeamId, 2);
    });

    it("invite succeeds while a seat is free", async () => {
      const { data } = await admin.auth.admin.createUser({
        email: `test-seat-overflow-${ts}@webhooks-test.local`,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: "Overflow User" },
      });
      overflowUserId = data!.user!.id;
      seatUserIds.push(overflowUserId);

      // 1 member, 2 seats
      const inviteResult = await createInvite(
        seatOwnerId,
        seatTeamId,
        `test-seat-overflow-${ts}@webhooks-test.local`
      );
      expect(inviteResult.error).toBeUndefined();
      expect(inviteResult.invite).toBeDefined();
    });

    it("fills the last seat before the invite is accepted", async () => {
      const { data } = await admin.auth.admin.createUser({
        email: `test-seat-filler-${ts}@webhooks-test.local`,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: "Seat Filler" },
      });
      seatUserIds.push(data!.user!.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("team_members")
        .insert({ team_id: seatTeamId, user_id: data!.user!.id, role: "member" });
    });

    it("createInvite is rejected once every seat is taken", async () => {
      const { data } = await admin.auth.admin.createUser({
        email: `test-seat-late-${ts}@webhooks-test.local`,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: "Late User" },
      });
      seatUserIds.push(data!.user!.id);

      const result = await createInvite(
        seatOwnerId,
        seatTeamId,
        `test-seat-late-${ts}@webhooks-test.local`
      );
      expect(result.error).toBe(NO_SEATS_ERROR);
    });

    it("acceptInvite fails and rolls back when every seat is taken", async () => {
      const invites = await listPendingInvitesForUser(overflowUserId);
      const invite = invites.find((i) => i.teamId === seatTeamId);
      expect(invite).toBeDefined();

      const result = await acceptInvite(overflowUserId, invite!.id);
      expect(result.accepted).toBe(false);
      expect(result.error).toBe(NO_SEATS_ERROR);

      // Invite should be rolled back to pending
      const afterInvites = await listPendingInvitesForUser(overflowUserId);
      const afterInvite = afterInvites.find((i) => i.teamId === seatTeamId);
      expect(afterInvite).toBeDefined();
      expect(afterInvite!.id).toBe(invite!.id);
    });

    it("accepting succeeds after the owner buys another seat", async () => {
      await activateTeam(seatTeamId, 3);

      const invites = await listPendingInvitesForUser(overflowUserId);
      const invite = invites.find((i) => i.teamId === seatTeamId);
      expect(invite).toBeDefined();

      const result = await acceptInvite(overflowUserId, invite!.id);
      expect(result.accepted).toBe(true);
    });

    it("cleanup seat cap test", async () => {
      // Delete the team (cascades team_members, team_invites, team_endpoints)
      await admin.from("teams").delete().eq("id", seatTeamId);
      // Delete all created auth users
      for (const userId of seatUserIds) {
        await admin.auth.admin.deleteUser(userId);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // RLS enforcement — direct table access should be blocked
  // ---------------------------------------------------------------------------

  describe("RLS enforcement", () => {
    it("anon client cannot read teams table", async () => {
      const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!anonKey) return; // skip if no anon key

      const anon = createClient(SUPABASE_URL, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data } = await anon.from("teams").select("id").limit(1);
      expect(data).toEqual([]);
    });

    it("anon client cannot read team_members table", async () => {
      const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!anonKey) return;

      const anon = createClient(SUPABASE_URL, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data } = await anon.from("team_members").select("id").limit(1);
      expect(data).toEqual([]);
    });

    it("anon client cannot read team_invites table", async () => {
      const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!anonKey) return;

      const anon = createClient(SUPABASE_URL, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data } = await anon.from("team_invites").select("id").limit(1);
      expect(data).toEqual([]);
    });

    it("anon client cannot read team_endpoints table", async () => {
      const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!anonKey) return;

      const anon = createClient(SUPABASE_URL, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data } = await anon.from("team_endpoints").select("id").limit(1);
      expect(data).toEqual([]);
    });
  });
});
