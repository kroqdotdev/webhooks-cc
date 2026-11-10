import { auditUserAction, requestVia } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { sharingOff, tunnelConfig } from "@/lib/tunnels/config";
import { shareFor } from "@/lib/tunnels/listing";
import { tunnelPlanOf } from "@/lib/tunnels/plan";
import { stopShares } from "@/lib/tunnels/stops";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOP_LIMIT = 60;
const STOP_WINDOW_MS = 60_000;

/**
 * Stops a run: the account's own, a teammate's preview under a name of one of
 * its teams, or a teammate's live tunnel on one of its own endpoints. The edge
 * closes the tunnel and the CLI exits, saying why.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!tunnelConfig()) return sharingOff();
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `shares-stop:${auth.userId}`,
    STOP_LIMIT,
    STOP_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  try {
    const plan = await tunnelPlanOf(auth.userId);
    const found = UUID.test(id) && plan ? await shareFor(id, auth.userId, plan.teamIds) : null;
    if (!found) {
      await auditUserAction(request, auth.userId, {
        action: "tunnel.share_stopped",
        status: 404,
        targetId: id,
      });
      return applyRateLimitHeaders(
        Response.json({ error: "Share not found" }, { status: 404 }),
        rateLimit
      );
    }
    const kind = found.owner
      ? "owner"
      : !found.mine
        ? "team"
        : requestVia(request) === "session"
          ? "stopped"
          : "api";
    const result = await stopShares({ shareId: found.row.id }, kind);
    await auditUserAction(request, auth.userId, {
      action: "tunnel.share_stopped",
      status: 200,
      targetId: found.row.id,
      targetUserId: found.mine ? null : found.row.user_id,
      metadata: { kind: found.row.kind, stopped: result.stopped },
    });
    return applyRateLimitHeaders(
      Response.json({ ok: true, stopped: result.stopped > 0, edgeReached: result.edgeReached }),
      rateLimit
    );
  } catch (error) {
    reportError("Failed to stop a share", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
