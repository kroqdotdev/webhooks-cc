import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { sharingOff, tunnelConfig } from "@/lib/tunnels/config";
import { releaseName } from "@/lib/tunnels/names";
import { tunnelPlanOf } from "@/lib/tunnels/plan";

const LIMIT = 30;
const WINDOW_MS = 10 * 60_000;

/**
 * Lets a kept name go: one's own, or any name of a team one owns. A live
 * preview under it stops, so its name's password never comes off a live link.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!tunnelConfig()) return sharingOff();
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { name } = await params;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `tunnel-names-release:${auth.userId}`,
    LIMIT,
    WINDOW_MS
  );
  if (rateLimit.response) return rateLimit.response;

  try {
    const plan = await tunnelPlanOf(auth.userId);
    if (!plan) return Response.json({ error: "Account not found" }, { status: 404 });
    const released = await releaseName(auth.userId, plan.teamIds, name.toLowerCase());
    const status = "error" in released ? released.status : 200;
    await auditUserAction(request, auth.userId, {
      action: "tunnel.name_released",
      status,
      ...("error" in released ? { reason: released.error } : {}),
      targetId: name.slice(0, 40),
    });
    if ("error" in released)
      return applyRateLimitHeaders(
        Response.json({ error: released.error }, { status: released.status }),
        rateLimit
      );
    return applyRateLimitHeaders(Response.json({ ok: true }), rateLimit);
  } catch (error) {
    reportError("Failed to release a tunnel name", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
