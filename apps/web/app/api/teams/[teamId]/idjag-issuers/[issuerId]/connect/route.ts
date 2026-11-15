import { authenticateSessionRequest } from "@/lib/api-auth";
import { auditUserAction } from "@/lib/audit";
import { disconnectMember, openConnectWindow, orgIssuersEnabled } from "@/lib/agent/org-issuers";
import { reportError } from "@/lib/observability";
import { closeRunsWithoutAccess } from "@/lib/tunnels/access";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";

/**
 * A member's pre-approval for one trusted issuer (migration 00105).
 *
 * POST opens a 10-minute window: the first assertion from the issuer inside
 * it whose email is the member's verified account email connects that
 * identity to the member at once, and the window closes. DELETE disconnects
 * what the member connected through the issuer (the delegations are revoked
 * with their tokens) and closes an open window.
 *
 * Session only, for the member themselves: an API key or agent token could
 * otherwise open its own way in. The session check refuses a session that
 * has not passed the account's second factor (lib/mfa-session.ts), as for
 * every session route. 404 while the feature is off.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ teamId: string; issuerId: string }> };

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function POST(request: Request, { params }: Ctx) {
  if (!orgIssuersEnabled()) return notFound();
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId, issuerId } = await params;
  if (!UUID.test(teamId) || !UUID.test(issuerId)) return notFound();

  const limit = await checkRateLimitByKeyWithInfo(`team-idjag-connect:${auth.userId}`, 10, 60_000);
  if (limit.response) return limit.response;

  try {
    const result = await openConnectWindow({ teamId, userId: auth.userId, issuerId });
    if (result.status !== "ok") {
      await auditUserAction(request, auth.userId, {
        action: "team.idjag_connect_opened",
        status: 404,
        teamId,
        targetId: issuerId,
      });
      return Response.json({ error: "Issuer not found or not a member" }, { status: 404 });
    }
    await auditUserAction(request, auth.userId, {
      action: "team.idjag_connect_opened",
      status: 200,
      teamId,
      targetId: issuerId,
      metadata: { issuer: result.issuer.slice(0, 200), expires_at: result.expiresAt },
    });
    return Response.json({ window_expires_at: result.expiresAt });
  } catch (error) {
    reportError("Failed to open a team ID-JAG connect window", error);
    await auditUserAction(request, auth.userId, {
      action: "team.idjag_connect_opened",
      status: 500,
      teamId,
      targetId: issuerId,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  if (!orgIssuersEnabled()) return notFound();
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId, issuerId } = await params;
  if (!UUID.test(teamId) || !UUID.test(issuerId)) return notFound();

  try {
    const result = await disconnectMember({ teamId, userId: auth.userId, issuerId });
    if (result.status !== "ok") {
      await auditUserAction(request, auth.userId, {
        action: "team.idjag_connect_disconnected",
        status: 404,
        teamId,
        targetId: issuerId,
      });
      return Response.json({ error: "Issuer not found or not a member" }, { status: 404 });
    }
    await auditUserAction(request, auth.userId, {
      action: "team.idjag_connect_disconnected",
      status: 200,
      teamId,
      targetId: issuerId,
      metadata: { issuer: result.issuer.slice(0, 200), revoked: result.revoked.length },
    });
    // Tunnels opened with their tokens end with them.
    if (result.revoked.length > 0) await closeRunsWithoutAccess();
    return Response.json({ success: true, revoked_connections: result.revoked.length });
  } catch (error) {
    reportError("Failed to disconnect a team ID-JAG connection", error);
    await auditUserAction(request, auth.userId, {
      action: "team.idjag_connect_disconnected",
      status: 500,
      teamId,
      targetId: issuerId,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
