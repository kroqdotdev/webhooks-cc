import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { sharingOff, tunnelConfig } from "@/lib/tunnels/config";
import { recentRequests } from "@/lib/tunnels/edge";
import { shareFor } from "@/lib/tunnels/listing";
import { tunnelPlanOf } from "@/lib/tunnels/plan";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_LIMIT = 120;
const READ_WINDOW_MS = 60_000;

/**
 * The last requests visitors made to a preview, from the edge's memory: no
 * addresses, only a number per visitor. `available` is false when the edge did
 * not answer; nothing survives an edge restart.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!tunnelConfig()) return sharingOff();
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `shares-requests:${auth.userId}`,
    READ_LIMIT,
    READ_WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  try {
    const plan = await tunnelPlanOf(auth.userId);
    const found = UUID.test(id) && plan ? await shareFor(id, auth.userId, plan.teamIds) : null;
    if (!found)
      return applyRateLimitHeaders(
        Response.json({ error: "Share not found" }, { status: 404 }),
        rateLimit
      );
    const activity = found.row.ended_at ? {} : await recentRequests([found.row.id]);
    const seen = activity?.[found.row.id]?.requests ?? [];
    return applyRateLimitHeaders(
      Response.json({
        available: activity !== null,
        requests: seen.map((r) => ({
          method: r.method,
          path: r.path,
          status: r.status,
          ms: r.ms,
          bytes: r.bytes,
          at: new Date(r.at).toISOString(),
          country: r.country,
          device: r.device,
          visitor: r.visitor,
        })),
      }),
      rateLimit
    );
  } catch (error) {
    reportError("Failed to read a share's requests", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
