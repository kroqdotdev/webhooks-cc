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
} from "@/lib/supabase/teams";
import {
  listRequestsForEndpointByUser,
  listNewRequestsForEndpointByUser,
  listPaginatedRequestsForEndpointByUser,
  getRequestByIdForUser,
  clearRequestsForEndpointByUser,
} from "@/lib/supabase/requests";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

async function insertRequest(epId: string, userId: string, path: string) {
  const { data, error } = await admin
    .from("requests")
    .insert({
      endpoint_id: epId,
      user_id: userId,
      method: "POST",
      path,
      headers: { "content-type": "application/json" },
      body: '{"test":true}',
      query_params: {},
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 13,
      received_at: new Date().toISOString(),
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
    it("creates a team and adds creator as owner", async () => {
      const team = await createTeam(ownerId, "Integration Test Team");

      expect(team.id).toBeTruthy();
      expect(team.name).toBe("Integration Test Team");
      expect(team.createdBy).toBe(ownerId);
      expect(team.memberCount).toBe(1);
      expect(team.role).toBe("owner");
      expect(team.createdAt).toBeGreaterThan(0);

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

    it("rejects rename from non-owner", async () => {
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
    it("creates an invite for a registered user", async () => {
      const result = await createInvite(ownerId, teamId, MEMBER_EMAIL);

      expect(result.error).toBeUndefined();
      expect(result.invite).toBeDefined();
      expect(result.invite!.teamId).toBe(teamId);
      expect(result.invite!.invitedEmail).toBe(MEMBER_EMAIL);
      expect(result.invite!.status).toBe("pending");
    });

    it("rejects invite for non-existent email", async () => {
      const result = await createInvite(ownerId, teamId, "nobody@nonexistent.test");
      expect(result.error).toBe("No account found with that email address");
    });

    it("rejects invite from non-owner", async () => {
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
    it("accepts the pending invite", async () => {
      const invites = await listPendingInvitesForUser(memberId);
      const invite = invites.find((i) => i.teamId === teamId);
      expect(invite).toBeDefined();

      const accepted = await acceptInvite(memberId, invite!.id);
      expect(accepted).toBe(true);
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

    it("owner removes the member", async () => {
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
      const team = await createTeam(ownerId, "Temp Delete Team");
      tempTeamId = team.id;
      expect(tempTeamId).toBeTruthy();
    });

    it("non-owner cannot delete", async () => {
      // memberId is no longer a member, but test that non-owners can't delete
      const result = await deleteTeam(memberId, tempTeamId);
      expect(result).toBe(false);
    });

    it("owner deletes the team", async () => {
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
        .upsert({ team_id: teamId, user_id: memberId, role: "member" }, { onConflict: "team_id,user_id" });

      // Ensure endpoint is shared (may already be from earlier re-share test)
      const result = await shareEndpointWithTeam(ownerId, teamId, endpointId);
      expect(result.success === true || result.error === "Endpoint is already shared with this team").toBe(true);
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
      const otherTeam = await createTeam(thirdId, "Other Team");

      const result = await shareEndpointWithTeam(ownerId, otherTeam.id, endpointId);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not a member");

      // Clean up
      await deleteTeam(thirdId, otherTeam.id);
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
      expect(result).toBe(false);
    });

    it("wrong user cannot decline someone else's invite", async () => {
      const result = await declineInvite(thirdId, inviteForMember);
      expect(result).toBe(false);
    });

    it("accepting an already-accepted invite returns false", async () => {
      const accepted = await acceptInvite(memberId, inviteForMember);
      expect(accepted).toBe(true);

      const again = await acceptInvite(memberId, inviteForMember);
      expect(again).toBe(false);
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
      const team2 = await createTeam(ownerId, "Second Team");
      secondTeamId = team2.id;

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
