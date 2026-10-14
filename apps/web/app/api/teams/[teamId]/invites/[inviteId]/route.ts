import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { checkRateLimitByKeyWithInfo, applyRateLimitHeaders } from "@/lib/rate-limit";
import { revokeInvite } from "@/lib/supabase/teams";
import { reportError } from "@/lib/observability";
import { isUuid } from "@/lib/uuid";

// Shares the invite POST route's bucket: sending and withdrawing invites are
// one budget, so a loop of invite and revoke cannot mail an address forever.
const INVITE_RATE_LIMIT_MAX = 20;
const INVITE_RATE_LIMIT_WINDOW_MS = 10 * 60_000;

/** The team owner withdraws a pending invite. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string; inviteId: string }> }
) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `team-invite:${auth.userId}`,
    INVITE_RATE_LIMIT_MAX,
    INVITE_RATE_LIMIT_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  const { teamId, inviteId } = await params;
  // A malformed id cannot name an invite, and as a uuid column value it would
  // also break the audit insert, so it ends here without one.
  if (!isUuid(teamId) || !isUuid(inviteId)) {
    return applyRateLimitHeaders(
      Response.json({ error: "Invite not found" }, { status: 404 }),
      rateLimit
    );
  }

  try {
    const revoked = await revokeInvite(auth.userId, teamId, inviteId);
    await auditUserAction(request, auth.userId, {
      action: "team.invite_revoked",
      status: revoked ? 200 : 404,
      teamId,
      targetId: inviteId,
    });
    if (!revoked) {
      return applyRateLimitHeaders(
        Response.json({ error: "Invite not found" }, { status: 404 }),
        rateLimit
      );
    }
    return applyRateLimitHeaders(Response.json({ revoked: true }), rateLimit);
  } catch (error) {
    reportError("Failed to revoke invite", error);
    await auditUserAction(request, auth.userId, {
      action: "team.invite_revoked",
      status: 500,
      teamId,
      targetId: inviteId,
    });
    return applyRateLimitHeaders(
      Response.json({ error: "Internal server error" }, { status: 500 }),
      rateLimit
    );
  }
}
