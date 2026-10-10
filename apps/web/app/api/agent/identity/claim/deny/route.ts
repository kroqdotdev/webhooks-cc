import { sendError } from "@appsignal/nodejs";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { auditAgentEvent } from "@/lib/audit";
import { accountEmail, denyClaim } from "@/lib/agent/claims";
import { agentError } from "@/lib/agent/errors";
import { readAgentBody } from "@/lib/agent/http";

/**
 * POST /api/agent/identity/claim/deny `{ claim_attempt_token }`: the human
 * the agent named declines. The agent's next poll answers access_denied.
 */
export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const body = await readAgentBody(request);
  if (!body || typeof body.claim_attempt_token !== "string") {
    return agentError(400, "invalid_request", "Send { claim_attempt_token }.");
  }

  try {
    const result = await denyClaim({
      attemptToken: body.claim_attempt_token,
      email: await accountEmail(auth.userId),
    });
    if (result.status === "ok") {
      await auditAgentEvent(request, {
        action: "agent.claim.denied",
        status: 200,
        actorUserId: auth.userId,
        targetId: result.registrationId,
      });
      return Response.json({ status: "denied" });
    }
    return result.status === "wrong_account"
      ? agentError(403, "wrong_account", "This agent asked for a different account.")
      : agentError(404, "not_found", "This link is unknown, used, or replaced by a newer one.");
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not decline the request.");
  }
}
