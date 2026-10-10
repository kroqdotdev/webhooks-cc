import { sendError } from "@appsignal/nodejs";
import { checkRateLimitWithInfo } from "@/lib/rate-limit";
import { auditAgentEvent } from "@/lib/audit";
import { NO_STORE_HEADERS, oauthError } from "@/lib/agent/errors";
import { readAgentBody } from "@/lib/agent/http";
import { revokeAgentToken } from "@/lib/agent/registrations";

/**
 * POST /api/oauth2/revoke (RFC 7009): an agent drops one of its access
 * tokens. Only agent tokens are deleted here, never dashboard or device
 * keys, and the answer is 200 whether or not the token existed (RFC 7009
 * 2.2). The identity assertion stays valid for a new exchange.
 */
export async function POST(request: Request) {
  const limit = await checkRateLimitWithInfo(request, "agent-revoke-token", 60, 60_000);
  if (limit.response) {
    return oauthError(429, "rate_limited", "Too many requests. Wait and retry.", {
      "Retry-After": limit.response.headers.get("Retry-After") ?? "60",
    });
  }

  const body = await readAgentBody(request, { form: true });
  if (!body || typeof body.token !== "string" || body.token.length === 0) {
    return oauthError(400, "invalid_request", "token is required.");
  }

  try {
    const registrationId = await revokeAgentToken(body.token);
    if (registrationId) {
      await auditAgentEvent(request, {
        action: "agent.token.revoked",
        status: 200,
        targetId: registrationId,
      });
    }
    return new Response(null, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return oauthError(500, "server_error", "Revocation failed. Retry later.");
  }
}
