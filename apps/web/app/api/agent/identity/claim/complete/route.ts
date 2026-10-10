import { sendError } from "@appsignal/nodejs";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { auditAgentEvent } from "@/lib/audit";
import { accountEmail, completeClaim, normalizeUserCode } from "@/lib/agent/claims";
import { MAX_CONNECTED_AGENTS } from "@/lib/agent/constants";
import { agentError, rateLimitedResponse } from "@/lib/agent/errors";
import { readAgentBody } from "@/lib/agent/http";
import { notifyAgentConnected } from "@/lib/agent/notify";

/**
 * POST /api/agent/identity/claim/complete `{ claim_attempt_token, user_code }`:
 * the signed-in human connects the agent to their account. Session only.
 * On success the registration is theirs, its sandbox endpoints are moved
 * into the account, and the agent's next claim poll collects credentials.
 */
export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const limit = await checkRateLimitByKeyWithInfo(
    `agent-claim-complete:${auth.userId}`,
    30,
    10 * 60_000
  );
  if (limit.response) return rateLimitedResponse(limit.response);

  const body = await readAgentBody(request);
  const code = normalizeUserCode(body?.user_code);
  if (!body || typeof body.claim_attempt_token !== "string" || !code) {
    return agentError(400, "invalid_request", "Enter the 6-digit code the agent shows.");
  }

  try {
    const email = await accountEmail(auth.userId);
    const result = await completeClaim({
      attemptToken: body.claim_attempt_token,
      userCode: code,
      userId: auth.userId,
      email,
    });

    if (result.status === "ok") {
      await auditAgentEvent(request, {
        action: "agent.claim.confirmed",
        status: 200,
        actorUserId: auth.userId,
        targetId: result.registrationId,
        metadata: { kind: result.kind, adopted_endpoints: result.adopted.length },
      });
      if (email) {
        await notifyAgentConnected({
          email,
          clientName: result.clientName,
          adopted: result.adopted,
        });
      }
      return Response.json({
        status: "connected",
        adopted: result.adopted,
        firstAgent: result.firstAgent,
      });
    }

    const refusal = {
      wrong_code: [400, "wrong_code", "That code is not right."],
      locked: [403, "locked", "Too many wrong codes. Ask the agent to start again."],
      expired: [410, "expired", "This code expired. Ask the agent for a new one."],
      denied: [403, "denied", "You declined this request."],
      wrong_account: [403, "wrong_account", "This agent asked for a different account."],
      too_many_agents: [
        409,
        "too_many_agents",
        `An account connects at most ${MAX_CONNECTED_AGENTS} agents. Disconnect one in Account first.`,
      ],
      already_claimed: [409, "already_claimed", "This agent is already connected."],
      invalid: [404, "not_found", "This link is unknown, used, or replaced by a newer one."],
    } as const;
    const [status, code_, message] = refusal[result.status];
    await auditAgentEvent(request, {
      action: "agent.claim.refused",
      status,
      actorUserId: auth.userId,
      targetId: result.registrationId ?? null,
      metadata: { code: result.status },
    });
    return agentError(
      status,
      code_,
      message,
      result.status === "wrong_code" ? { remaining: result.remaining } : {}
    );
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not connect the agent. Retry.");
  }
}
