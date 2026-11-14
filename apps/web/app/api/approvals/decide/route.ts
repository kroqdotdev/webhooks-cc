import { auditUserAction } from "@/lib/audit";
import { loggablePolarError } from "@/lib/polar";
import { deviceApprover } from "@/lib/device-session";
import {
  ApprovalError,
  decideApproval,
  reopenBrowserApproval,
  withdrawApproval,
} from "@/lib/approvals/store";
import { authorizationUrl, browserCookie, googleConfig } from "@/lib/integrations/google";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const decideBody = z.object({
  code: z.string(),
  decision: z.enum(["approve", "deny", "withdraw"]),
  /** What the person chose on the page, for the action (a Drive pick's file). */
  input: z.unknown().optional(),
});

/**
 * POST /api/approvals/decide { code, decision: "approve" | "deny" | "withdraw", input? }:
 * the person's answer on the approval page, from a browser session of the
 * account the approval is for (past two-factor sign-in when it has one).
 * "withdraw" takes back an approval its asker has not collected yet; the
 * answer says "collected" when it already was (revoke the key instead).
 */
export async function POST(request: Request) {
  const rateLimited = await checkRateLimit(request, "approval-decide", 10);
  if (rateLimited) return rateLimited;

  const parsed = await parseJsonBodyWith(request, decideBody, {
    maxSize: 2048,
    message: 'Send { code, decision: "approve" | "deny" | "withdraw" }',
    invalidJson: "Invalid JSON",
  });
  if ("error" in parsed) return parsed.error;
  const { code, decision, input } = parsed.data;

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
    const decided = await decideApproval(code, approver.userId, approve, input);
    // A Google connection: the browser goes on to Google to finish it.
    if (decided.browser) return googleConsent(request, approver.userId, decided.id, code);
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
    // An action may call Polar, whose errors carry its response body.
    reportError("POST /api/approvals/decide failed", loggablePolarError(err));
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
  } else if (decided.action === "teams.delete") {
    await auditUserAction(request, userId, {
      action: "team.deleted",
      status: 204,
      teamId: typeof params.teamId === "string" ? params.teamId : null,
      metadata: via,
    });
  } else if (decided.action === "teams.invite") {
    await auditUserAction(request, userId, {
      action: "team.invite_sent",
      status: 200,
      teamId: typeof params.teamId === "string" ? params.teamId : null,
      targetId: typeof result.id === "string" ? result.id : null,
      metadata: {
        ...via,
        invited_email: typeof params.email === "string" ? params.email : null,
      },
    });
  } else if (decided.action === "ai.assist") {
    const ask = params.ask as { kind?: string } | undefined;
    await auditUserAction(request, userId, {
      action: "endpoint.ai_assist",
      status: 200,
      targetId: typeof params.slug === "string" ? params.slug : null,
      // What was asked and how it went; never the emails or the patterns.
      metadata: {
        ...via,
        kind: ask?.kind,
        samples: Array.isArray(params.requestIds) ? params.requestIds.length : 0,
        proposed: Array.isArray(result.fields) ? result.fields.length : 0,
        dropped: result.dropped,
      },
    });
  } else if (decided.action === "account.rename") {
    await auditUserAction(request, userId, {
      action: "account.name_updated",
      status: 200,
      metadata: { ...via, cleared: result.name === null },
    });
  }
}

/**
 * A Google connection an agent asked for: approving sends this browser to
 * Google's consent page, and the callback completes the approval and comes
 * back to its page. The cookie ties the callback to this browser, as when
 * the dashboard connects.
 */
async function googleConsent(
  request: Request,
  userId: string,
  approvalId: string,
  code: string
): Promise<Response> {
  const config = googleConfig();
  if (!config) {
    await reopenBrowserApproval(approvalId, userId);
    return Response.json({ error: "Google Sheets is not set up on this server." }, { status: 503 });
  }
  const { url, browserNonce } = authorizationUrl(
    config,
    userId,
    `/approve?code=${encodeURIComponent(code.trim().toUpperCase())}`,
    "webhooks",
    undefined,
    approvalId
  );
  await auditUserAction(request, userId, {
    action: "approval.approved",
    status: 200,
    targetId: approvalId,
    metadata: { action: "google.connect" },
  });
  const response = Response.json({ status: "redirect", url });
  response.headers.append(
    "set-cookie",
    browserCookie(browserNonce, new URL(request.url).protocol === "https:")
  );
  return response;
}
