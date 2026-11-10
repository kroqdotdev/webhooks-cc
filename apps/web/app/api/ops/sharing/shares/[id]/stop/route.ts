import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { shareById } from "@/lib/tunnels/moderation";
import { describeStopped, sharingOffForOps } from "@/lib/tunnels/ops-request";
import { stopShares } from "@/lib/tunnels/stops";
import { isUuid } from "@/lib/uuid";

/** Stops one live run; its CLI is told webhooks.cc stopped it. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const off = sharingOffForOps();
  if (off) return off;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  try {
    const share = await shareById(id);
    if (!share) return opsJson({ error: "Not found" }, { status: 404 });
    const result = await stopShares({ shareId: id }, "staff");
    await auditUserAction(request, auth.userId, {
      action: "ops.share_stopped",
      status: 200,
      targetId: id,
      targetUserId: share.user?.id ?? null,
      metadata: { stopped: result.stopped },
    });
    return opsJson({
      ok: true,
      ...result,
      message: describeStopped(result.stopped, result.edgeReached),
    });
  } catch (error) {
    reportError("[ops] stopping a share failed", error);
    return opsJson({ error: "The share could not be stopped." }, { status: 500 });
  }
}
