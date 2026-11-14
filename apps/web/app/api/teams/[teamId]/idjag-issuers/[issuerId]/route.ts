import { authenticateSessionRequest } from "@/lib/api-auth";
import { auditUserAction } from "@/lib/audit";
import { orgIssuersEnabled, removeTeamIssuer } from "@/lib/agent/org-issuers";
import { reportError } from "@/lib/observability";

/**
 * Stop trusting an organisation ID-JAG issuer (the owner only, session
 * only). Every agent connection made through it is revoked with its tokens
 * in the same transaction (remove_team_idjag_issuer(), migration 00105).
 * 404 while the feature is off.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string; issuerId: string }> }
) {
  if (!orgIssuersEnabled()) return notFound();
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId, issuerId } = await params;
  if (!UUID.test(teamId) || !UUID.test(issuerId)) return notFound();

  try {
    const result = await removeTeamIssuer({ teamId, userId: auth.userId, issuerId });
    if (result.status !== "ok") {
      await auditUserAction(request, auth.userId, {
        action: "team.idjag_issuer_removed",
        status: 404,
        teamId,
        targetId: issuerId,
      });
      return Response.json({ error: "Issuer not found or not owner" }, { status: 404 });
    }
    await auditUserAction(request, auth.userId, {
      action: "team.idjag_issuer_removed",
      status: 200,
      teamId,
      targetId: issuerId,
      metadata: { issuer: result.issuer.slice(0, 200), revoked: result.revoked.length },
    });
    return Response.json({ success: true, revoked_connections: result.revoked.length });
  } catch (error) {
    reportError("Failed to remove a team ID-JAG issuer", error);
    await auditUserAction(request, auth.userId, {
      action: "team.idjag_issuer_removed",
      status: 500,
      teamId,
      targetId: issuerId,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
