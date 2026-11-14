import { z } from "zod";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { auditUserAction } from "@/lib/audit";
import {
  addTeamIssuer,
  checkAllowedClientIds,
  checkOrgIssuer,
  listTeamIssuers,
  MAX_TEAM_ISSUERS,
  orgIssuerPrefixes,
  orgIssuersEnabled,
  teamRole,
  type TeamIdJagIssuer,
} from "@/lib/agent/org-issuers";
import { reportError } from "@/lib/observability";
import { parseJsonBodyWith } from "@/lib/request-validation";

/**
 * Organisation ID-JAG issuers a team trusts (lib/agent/org-issuers.ts,
 * migration 00105). Session only: trusting an issuer lets its assertions
 * connect agents to members' accounts, so a person decides. Members may
 * look; only the owner adds. With AGENT_IDJAG_ORG_ISSUER_PREFIXES empty
 * (production until announced) every call answers 404.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const addBody = z.object({
  issuer: z.unknown(),
  allowed_client_ids: z.unknown().optional(),
});

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

function issuerJson(row: TeamIdJagIssuer) {
  return {
    id: row.id,
    issuer: row.issuer,
    allowed_client_ids: row.allowedClientIds,
    created_at: row.createdAt,
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  if (!orgIssuersEnabled()) return notFound();
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;
  if (!UUID.test(teamId)) return notFound();

  try {
    const role = await teamRole(teamId, auth.userId);
    if (!role) return notFound();
    const issuers = await listTeamIssuers(teamId);
    return Response.json({
      issuers: issuers.map(issuerJson),
      prefixes: orgIssuerPrefixes(),
      max_issuers: MAX_TEAM_ISSUERS,
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
