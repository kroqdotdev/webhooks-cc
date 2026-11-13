import { auditUserAction } from "@/lib/audit";
import { deviceApprover } from "@/lib/device-session";
import { ApprovalError, decideApproval, withdrawApproval } from "@/lib/approvals/store";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";

/**
 * POST /api/approvals/decide { code, decision: "approve" | "deny" | "withdraw" }:
 * the person's answer on the approval page, from a browser session of the
 * account the approval is for (past two-factor sign-in when it has one).
 * "withdraw" takes back an approval its asker has not collected yet; the
 * answer says "collected" when it already was (revoke the key instead).
 */
export async function POST(request: Request) {
  const rateLimited = await checkRateLimit(request, "approval-decide", 10);
  if (rateLimited) return rateLimited;

  const parsed = await parseJsonBody(request, 1024);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;
  const decision = body.decision;
  if (
    typeof body.code !== "string" ||
    (decision !== "approve" && decision !== "deny" && decision !== "withdraw")
  ) {
    return Response.json(
      { error: 'Send { code, decision: "approve" | "deny" | "withdraw" }' },
      { status: 400 }
    );
  }

  try {
    const approver = await deviceApprover();
    if ("error" in approver) return approver.error;

    if (decision === "withdraw") {
      const withdrawn = await withdrawApproval(body.code, approver.userId);
      if (!withdrawn.collected) {
        await auditUserAction(request, approver.userId, {
          action: "approval.denied",
          status: 200,
          targetId: withdrawn.id,
          metadata: { action: withdrawn.action, withdrawn: true },
        });
      }
      return Response.json({ status: withdrawn.collected ? "collected" : "withdrawn" });
    }

    const approve = decision === "approve";
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
