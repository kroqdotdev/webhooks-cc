import { sendError } from "@appsignal/nodejs";
import { checkRateLimitWithInfo } from "@/lib/rate-limit";
import { auditAgentEvent, emailDomain } from "@/lib/audit";
import {
  claimAttemptBlock,
  claimAttemptId,
  normalizeLoginHint,
  startClaimAttempt,
} from "@/lib/agent/claims";
import {
  AgentError,
  agentError,
  agentErrorResponse,
  rateLimitedResponse,
} from "@/lib/agent/errors";
import { readAgentBody } from "@/lib/agent/http";

/**
 * POST /api/agent/identity/claim (auth.md Step 4a): `{ claim_token, email }`
 * starts a claim attempt, or replaces the current one when its code ran
 * out; the old link stops working. `email` names the one person who may
 * complete it; a service_auth registration keeps the email it registered
 * with and may leave it out.
 */
export async function POST(request: Request) {
  const limit = await checkRateLimitWithInfo(request, "agent-claim", 20, 60 * 60 * 1000);
  if (limit.response) return rateLimitedResponse(limit.response);

  const body = await readAgentBody(request);
  if (!body || typeof body.claim_token !== "string" || !body.claim_token.startsWith("clm_")) {
    return agentError(400, "invalid_request", "Send { claim_token, email }.");
  }

  try {
    const loginHint = body.email === undefined ? null : normalizeLoginHint(body.email);
    const attempt = await startClaimAttempt({ claimToken: body.claim_token, loginHint });
    await auditAgentEvent(request, {
      action: "agent.claim.requested",
      status: 200,
      targetId: attempt.registrationId,
      metadata: {
        kind: attempt.kind,
        attempt: attempt.attempt,
        login_hint_domain: loginHint ? emailDomain(loginHint) : null,
      },
    });
    return Response.json(
      {
        registration_id: attempt.registrationId,
        claim_attempt_id: claimAttemptId(attempt.attemptTokenHash),
        status: "initiated",
        expires_at: attempt.expiresAt.toISOString(),
        claim_attempt: claimAttemptBlock(attempt),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof AgentError) return agentErrorResponse(error);
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not start the claim. Retry later.");
  }
}
