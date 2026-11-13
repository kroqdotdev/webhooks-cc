import { auditUserAction } from "@/lib/audit";
import { deviceApprover } from "@/lib/device-session";
import { ApprovalError, decideApproval } from "@/lib/approvals/store";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";

/**
 * POST /api/approvals/decide { code, decision: "approve" | "deny" }: the
 * person's answer on the approval page, from a browser session of the
 * account the approval is for (past two-factor sign-in when it has one).
 */
export async function POST(request: Request) {
  const rateLimited = await checkRateLimit(request, "approval-decide", 10);
  if (rateLimited) return rateLimited;

  const parsed = await parseJsonBody(request, 1024);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;
  if (typeof body.code !== "string" || (body.decision !== "approve" && body.decision !== "deny")) {
    return Response.json({ error: 'Send { code, decision: "approve" | "deny" }' }, { status: 400 });
  }

  try {
    const approver = await deviceApprover();
    if ("error" in approver) return approver.error;
    const approve = body.decision === "approve";
    const decided = await decideApproval(body.code, approver.userId, approve);
    await auditUserAction(request, approver.userId, {
      action: approve ? "approval.approved" : "approval.denied",
      status: 200,
      targetId: decided.id,
      metadata: { action: decided.action },
    });
    return Response.json({ status: approve ? "approved" : "denied" });
  } catch (err) {
    if (err instanceof ApprovalError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    reportError("POST /api/approvals/decide failed", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
