import { z } from "zod";
import { authenticateRequestRequireUser, authenticateSessionRequest } from "@/lib/api-auth";
import { auditUserAction } from "@/lib/audit";
import {
  addTeamIssuer,
  checkAllowedClientIds,
  checkOrgIssuer,
  CONNECT_WINDOW_SECONDS,
  listTeamIssuers,
  MAX_TEAM_ISSUERS,
  memberConnectStates,
  type MemberConnectState,
  orgIssuerPrefixes,
  orgIssuersEnabled,
  teamRole,
  trustRowConnectionCounts,
  type TeamIdJagIssuer,
} from "@/lib/agent/org-issuers";
import { reportError } from "@/lib/observability";
import { parseJsonBodyWith } from "@/lib/request-validation";

/**
 * Organisation ID-JAG issuers a team trusts (lib/agent/org-issuers.ts,
 * migration 00105). Members may look, with a session, an API key or an
 * agent token (each issuer with the caller's own window and connections,
 * so an agent can tell its human where to connect). Adding takes the
 * owner's session: trusting an issuer lets its assertions connect agents
 * to members' accounts, so a person decides. With
 * AGENT_IDJAG_ORG_ISSUER_PREFIXES empty (production until announced) every
 * call answers 404.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const addBody = z.object({
  issuer: z.unknown(),
  allowed_client_ids: z.unknown().optional(),
});

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

function issuerJson(row: TeamIdJagIssuer, connect?: MemberConnectState, connected?: number) {
  return {
    id: row.id,
    issuer: row.issuer,
    allowed_client_ids: row.allowedClientIds,
    created_at: row.createdAt,
    // The owner's: how many agents removing the row would disconnect.
    ...(connected === undefined ? {} : { connected_agents: connected }),
    ...(connect
      ? {
          connect: {
            window_expires_at: connect.windowExpiresAt,
            connections: connect.connections.map((c) => ({
              id: c.id,
              client_name: c.clientName,
              connected_at: c.connectedAt,
            })),
          },
        }
      : {}),
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  if (!orgIssuersEnabled()) return notFound();
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;
  if (!UUID.test(teamId)) return notFound();

  try {
    const role = await teamRole(teamId, auth.userId);
    if (!role) return notFound();
    const issuers = await listTeamIssuers(teamId);
    const trustIds = issuers.map((row) => row.id);
    const [states, counts] = await Promise.all([
      memberConnectStates(auth.userId, trustIds),
      role === "owner" ? trustRowConnectionCounts(trustIds) : Promise.resolve(null),
    ]);
    return Response.json({
      issuers: issuers.map((row) =>
        issuerJson(row, states.get(row.id), counts ? (counts.get(row.id) ?? 0) : undefined)
      ),
      prefixes: orgIssuerPrefixes(),
      max_issuers: MAX_TEAM_ISSUERS,
      connect_window_seconds: CONNECT_WINDOW_SECONDS,
      // Adding and removing take the owner's session.
      can_manage: role === "owner",
    });
  } catch (error) {
    reportError("Failed to list team ID-JAG issuers", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  if (!orgIssuersEnabled()) return notFound();
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;
  if (!UUID.test(teamId)) return notFound();

  const parsed = await parseJsonBodyWith(request, addBody, {
    message: "Send { issuer, allowed_client_ids? }",
  });
  if ("error" in parsed) return parsed.error;

  const refuse = async (status: number, reason: string) => {
    await auditUserAction(request, auth.userId, {
      action: "team.idjag_issuer_added",
      status,
      teamId,
      reason,
    });
    return Response.json({ error: reason }, { status });
  };

  const issuer = checkOrgIssuer(parsed.data.issuer);
  if (!issuer.ok) return refuse(400, issuer.reason);
  const clientIds = checkAllowedClientIds(parsed.data.allowed_client_ids);
  if (!clientIds.ok) return refuse(400, clientIds.reason);

  try {
    const result = await addTeamIssuer({
      teamId,
      userId: auth.userId,
      issuer: issuer.issuer,
      clientIds: clientIds.clientIds,
    });
    switch (result.status) {
      case "not_owner":
        await auditUserAction(request, auth.userId, {
          action: "team.idjag_issuer_added",
          status: 404,
          teamId,
        });
        return Response.json({ error: "Team not found or not owner" }, { status: 404 });
      case "exists":
        return refuse(409, "The team already trusts this issuer.");
      case "limit":
        return refuse(400, `A team can trust at most ${MAX_TEAM_ISSUERS} issuers.`);
      case "ok":
        await auditUserAction(request, auth.userId, {
          action: "team.idjag_issuer_added",
          status: 201,
          teamId,
          targetId: result.issuer.id,
          metadata: {
            issuer: result.issuer.issuer.slice(0, 200),
            allowed_client_ids: result.issuer.allowedClientIds.length,
          },
        });
        return Response.json(issuerJson(result.issuer), { status: 201 });
    }
  } catch (error) {
    reportError("Failed to add a team ID-JAG issuer", error);
    await auditUserAction(request, auth.userId, {
      action: "team.idjag_issuer_added",
      status: 500,
      teamId,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
