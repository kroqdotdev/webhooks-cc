import { auditUserAction } from "@/lib/audit";
import { deviceApprover } from "@/lib/device-session";
import { ApprovalError, decideApproval, withdrawApproval } from "@/lib/approvals/store";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const decideBody = z.object({
  code: z.string(),
  decision: z.enum(["approve", "deny", "withdraw"]),
});

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

  const parsed = await parseJsonBodyWith(request, decideBody, {
    maxSize: 1024,
    message: 'Send { code, decision: "approve" | "deny" | "withdraw" }',
    invalidJson: "Invalid JSON",
  });
  if ("error" in parsed) return parsed.error;
  const { code, decision } = parsed.data;

  try {
    const approver = await deviceApprover();
    if ("error" in approver) return approver.error;

    if (decision === "withdraw") {
      const withdrawn = await withdrawApproval(code, approver.userId);
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
    const decided = await decideApproval(code, approver.userId, approve);
    await auditUserAction(request, approver.userId, {
      action: approve ? "approval.approved" : "approval.denied",
      status: 200,
      targetId: decided.id,
      metadata: { action: decided.action },
    });
    if (decided.done) await auditDone(request, approver.userId, decided);
    // "done": the action ran on approval; "approved": the asker collects it.
    return Response.json({ status: approve ? (decided.done ? "done" : "approved") : "denied" });
  } catch (err) {
    if (err instanceof ApprovalError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    reportError("POST /api/approvals/decide failed", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * The event the action's own route writes when a session does it directly,
 * so the trail (and what mirrors it) reads the same either way.
 */
async function auditDone(
  request: Request,
  userId: string,
  decided: { id: string; action: string; result?: unknown; params?: unknown }
): Promise<void> {
  const result = (decided.result ?? {}) as Record<string, unknown>;
  const params = (decided.params ?? {}) as Record<string, unknown>;
  const via = { approvalId: decided.id };
  if (decided.action === "request_shares.create") {
    await auditUserAction(request, userId, {
      action: "request.share_created",
      status: 200,
      targetId: typeof result.id === "string" ? result.id : null,
      metadata: { ...via, expiresInDays: params.expiresInDays },
    });
  } else if (decided.action === "domains.remove") {
    await auditUserAction(request, userId, {
      action: "domain.deleted",
      status: 204,
      teamId: typeof params.teamId === "string" ? params.teamId : null,
      metadata: { ...via, id: result.domainId },
    });
  } else if (decided.action === "account.rename") {
    await auditUserAction(request, userId, {
      action: "account.name_updated",
      status: 200,
      metadata: { ...via, cleared: result.name === null },
    });
  }
}
