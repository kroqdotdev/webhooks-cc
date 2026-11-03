import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { decideRefund } from "@/lib/ops/refunds";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { isUuid } from "@/lib/uuid";

/** Approve (the worker then refunds exactly the prepared orders) or dismiss. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return opsJson({ error: "Not found" }, { status: 404 });
  let decision: unknown;
  try {
    decision = ((await request.json()) as Record<string, unknown>).decision;
  } catch {
    return opsJson({ error: "Invalid JSON." }, { status: 400 });
  }
  if (decision !== "approve" && decision !== "dismiss") {
    return opsJson({ error: "Approve or dismiss." }, { status: 400 });
  }
  try {
    const done = await decideRefund(id, decision);
    await auditUserAction(request, auth.userId, {
      action: decision === "approve" ? "ops.refund_approved" : "ops.refund_dismissed",
      status: done ? 200 : 409,
      targetId: id,
    });
    if (!done) {
      return opsJson(
        { error: "This refund is no longer waiting for a decision. Reload to see where it is." },
        { status: 409 }
      );
    }
    return opsJson({ ok: true });
  } catch (error) {
    reportError("[ops] deciding a refund failed", error);
    return opsJson({ error: "The decision could not be saved." }, { status: 500 });
  }
}
