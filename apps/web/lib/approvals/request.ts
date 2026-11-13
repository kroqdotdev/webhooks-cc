import { auditUserAction } from "@/lib/audit";
import { deviceRequester } from "@/lib/device-requester";
import { buildApprovalRequestEmail } from "@/lib/email/approval-request-email";
import { sendEmail } from "@/lib/email/mailer";
import { reportError } from "@/lib/observability";
import { actionSpec, type ApprovalAction } from "./actions";
import { ApprovalError, approvalEmailRecipient, createApproval, type Asker } from "./store";

/**
 * Answers a request made with an API key or an agent token, for an action a
 * person must approve: checks the parameters, records the approval, and
 * answers 202 with it ({ approval: { id, status, action, summary, code, url,
 * expiresAt } }). The asker shows the person the link and polls
 * GET /api/approvals/{id} until it is answered. The approval page and its
 * routes are the only way to answer one.
 */
export async function requestApproval(
  request: Request,
  asker: Asker,
  action: ApprovalAction,
  input: unknown
): Promise<Response> {
  try {
    const parsed = await actionSpec(action).parse(input, asker.userId);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: parsed.status ?? 400 });
    }
    const { approval, requester } = await createApproval({
      asker,
      action,
      params: parsed.params,
      requester: deviceRequester(request, {}),
    });
    await auditUserAction(request, asker.userId, {
      action: "approval.requested",
      status: 202,
      targetId: approval.id,
      metadata: { action },
    });
    await notifyOwner(asker.userId, requester, approval.summary, approval.url).catch((err) =>
      reportError("Failed to send an approval email", err)
    );
    return Response.json({ approval }, { status: 202 });
  } catch (err) {
    if (err instanceof ApprovalError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    reportError("Failed to record an approval", err);
    return Response.json({ error: "Failed to ask for approval" }, { status: 500 });
  }
}

async function notifyOwner(
  userId: string,
  requester: string,
  summary: string,
  url: string
): Promise<void> {
  const to = await approvalEmailRecipient(userId);
  if (!to) return;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://webhooks.cc";
  const asker = requester.charAt(0).toUpperCase() + requester.slice(1);
  await sendEmail(buildApprovalRequestEmail({ to, summary, requester: asker, url, appUrl }));
}
