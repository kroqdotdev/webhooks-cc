import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { ApprovalError, pollApproval } from "@/lib/approvals/store";
import { reportError } from "@/lib/observability";
import { checkRateLimit } from "@/lib/rate-limit";
import { ApiKeyLimitError } from "@/lib/supabase/api-keys";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/approvals/{id}: the asker's poll. Answers the approval's status
 * (pending, approved, denied, completed or expired); the first poll after the
 * person approved runs the action and carries its result, once (a new API
 * key's `key` is only ever in that answer). Only the API key or agent
 * registration that asked gets an answer; anyone else gets 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Two a second at most: the SDK polls at least a second apart.
  const rateLimited = await checkRateLimit(request, "approval-poll", 120);
  if (rateLimited) return rateLimited;

  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { id } = await params;
  const notFound = Response.json({ error: "Approval not found" }, { status: 404 });
  if (!UUID.test(id) || !auth.keyId) return notFound;

  try {
    const polled = await pollApproval(id, {
      userId: auth.userId,
      keyId: auth.keyId,
      agentRegistrationId: auth.agentRegistrationId,
    });
    if (!polled) return notFound;
    if (polled.result && polled.approval.action === "api_keys.create") {
      await auditUserAction(request, auth.userId, {
        action: "api_key.created",
        status: 200,
        targetId: String(polled.result.keyPrefix ?? ""),
        metadata: { name: polled.result.name ?? null, approval: polled.approval.id },
      });
    }
    return Response.json(polled);
  } catch (err) {
    if (err instanceof ApprovalError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ApiKeyLimitError) {
      return Response.json(
        { error: `${err.message}. Revoke one, then poll again before the approval expires.` },
        { status: 409 }
      );
    }
    reportError("GET /api/approvals/[id] failed", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
