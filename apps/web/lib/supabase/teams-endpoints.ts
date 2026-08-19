import { createAdminClient } from "./admin";
import type { Json } from "./database";
import { requireActiveTeam } from "./teams-gating";
import type { TeamEndpointShare, TeamEndpointRow, SharedEndpoint } from "./teams-types";

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

function normalizeMockResponse(mock_response: Json | null): SharedEndpoint["mockResponse"] {
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

/**
 * Narrows a set of team ids to the subscribed ones. Callers that only need a
 * yes/no answer pass `limit: 1`.
 */
async function filterActiveTeamIds(teamIds: string[], limit?: number): Promise<string[]> {
  if (teamIds.length === 0) return [];

  const admin = createAdminClient();
  let query = admin
    .from("teams")
    .select("id")
    .in("id", teamIds)
    .not("subscription_status", "is", null);
  if (limit !== undefined) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => row.id);
}

// ---------------------------------------------------------------------------
// shareEndpointWithTeam
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
  const { data: membership, error: memberError } = await admin
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();

  if (memberError) throw memberError;
  if (!membership) return { success: false, error: "You are not a member of this team" };

  // Sharing hands a whole team read access, so it needs the team's subscription.
  // Unsharing stays ungated: revoking access must keep working after a lapse.
  const inactiveError = await requireActiveTeam(teamId);
  if (inactiveError) return { success: false, error: inactiveError };

  // Insert share
  const { error: insertError } = await admin
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
// unshareEndpointFromTeam
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

  const { data, error } = await admin
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
// removeMemberShares
// ---------------------------------------------------------------------------

/**
 * Deletes the share rows a departing member created for this team, so their
 * endpoints stop billing the team's pooled quota. Callers run this BEFORE
 * deleting the membership row and let a failure propagate: aborting the
 * removal is recoverable (retry), while a swallowed failure after the
 * membership is gone would leave the departed member's traffic draining the
 * pool with nothing left to retry it. On the seat-revocation webhook path the
 * thrown error becomes a 500, which Polar redelivers, so cleanup is retried
 * there automatically.
 */
export async function removeMemberShares(teamId: string, userId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("team_endpoints")
    .delete()
    .eq("team_id", teamId)
    .eq("shared_by", userId);

  if (error) throw error;
}

// ---------------------------------------------------------------------------
// getTeamSharesForEndpoint
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
  const { data: sharesData, error: sharesError } = await admin
    .from("team_endpoints")
    .select("team_id, endpoint_id, shared_by")
    .eq("endpoint_id", endpointId);

  if (sharesError) throw sharesError;
  if (!sharesData || sharesData.length === 0) return [];

  const shares = sharesData as Pick<TeamEndpointRow, "team_id" | "endpoint_id" | "shared_by">[];
  const teamIds = [...new Set(shares.map((s) => s.team_id))];

  // Fetch team names
  const { data: teamsData, error: teamsError } = await admin
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
// getSharedEndpointsForUser
// ---------------------------------------------------------------------------

export async function getSharedEndpointsForUser(userId: string): Promise<SharedEndpoint[]> {
  const admin = createAdminClient();

  // Get all teams the user is a member of
  const { data: memberships, error: memberError } = await admin
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId);

  if (memberError) throw memberError;
  if (!memberships || memberships.length === 0) return [];

  const teamIds = memberships.map((m) => m.team_id);

  // Suspended teams share nothing: a team is usable only while it carries a
  // subscription of its own, whatever personal plan its members are on.
  const { data: teamsData, error: teamsError } = await admin
    .from("teams")
    .select("id, name")
    .in("id", teamIds)
    .not("subscription_status", "is", null);

  if (teamsError) throw teamsError;

  const activeTeams = (teamsData ?? []) as { id: string; name: string }[];
  if (activeTeams.length === 0) return [];

  const activeTeamIds = activeTeams.map((t) => t.id);
  const teamMap = new Map(activeTeams.map((t) => [t.id, t.name]));

  // Fetch all shared endpoints for active (non-suspended) teams
  const { data: sharesData, error: sharesError } = await admin
    .from("team_endpoints")
    .select("team_id, endpoint_id, shared_by")
    .in("team_id", activeTeamIds);

  if (sharesError) throw sharesError;
  if (!sharesData || sharesData.length === 0) return [];

  const shares = sharesData as Pick<TeamEndpointRow, "team_id" | "endpoint_id" | "shared_by">[];

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

  const endpointMap = new Map((endpointsData as EndpointMinRow[]).map((e) => [e.id, e]));

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
// resolveEndpointAccess
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

  // A non-owner needs one team that the endpoint is shared with, that they
  // belong to, and that carries a subscription. Personal plans do not enter
  // into it — neither the requester's nor the endpoint owner's.
  const { data: teamAccess, error: teamAccessError } = await admin
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId);

  if (teamAccessError) throw teamAccessError;
  if (!teamAccess || teamAccess.length === 0) return null;

  const userTeamIds = teamAccess.map((m) => m.team_id);

  // Every matching share, not just the first: one lapsed team must not mask a
  // subscribed one that shares the same endpoint.
  const { data: shareAccess, error: shareAccessError } = await admin
    .from("team_endpoints")
    .select("team_id")
    .eq("endpoint_id", endpoint.id)
    .in("team_id", userTeamIds);

  if (shareAccessError) throw shareAccessError;
  if (!shareAccess || shareAccess.length === 0) return null;

  const shareTeamIds = [...new Set(shareAccess.map((s) => s.team_id))];
  const activeShareTeamIds = await filterActiveTeamIds(shareTeamIds, 1);
  if (activeShareTeamIds.length === 0) return null;

  return { endpointId: endpoint.id, ownerId, isOwner: false };
}

// ---------------------------------------------------------------------------
// getShareMetadataForOwnedEndpoints
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
  const { data: sharesData, error: sharesError } = await admin
    .from("team_endpoints")
    .select("team_id, endpoint_id, shared_by")
    .in("endpoint_id", endpointIds);

  if (sharesError) throw sharesError;
  if (!sharesData || sharesData.length === 0) return new Map();

  const shares = sharesData as Pick<TeamEndpointRow, "team_id" | "endpoint_id" | "shared_by">[];
  const teamIds = [...new Set(shares.map((s) => s.team_id))];

  // Fetch team names
  const { data: teamsData, error: teamsError } = await admin
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
