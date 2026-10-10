import { sendError } from "@appsignal/nodejs";
import { checkRateLimitWithInfo } from "@/lib/rate-limit";
import { auditAgentEvent } from "@/lib/audit";
import { assertionSigningConfigured } from "@/lib/agent/assertion";
import { CLAIM_GRANT, JWT_BEARER_GRANT } from "@/lib/agent/constants";
import { oauthError, oauthJson } from "@/lib/agent/errors";
import { issuer, readAgentBody } from "@/lib/agent/http";
import { exchangeAssertion, InvalidGrantError } from "@/lib/agent/registrations";

/**
 * POST /api/oauth2/token (auth.md Step 5). The jwt-bearer grant (RFC 7523)
 * exchanges a registration's identity assertion for a one-hour access
 * token. Form-encoded per RFC 6749; JSON is accepted too. Answers use the
 * RFC 6749 error envelope and are never cached.
 */
export async function POST(request: Request) {
  const limit = await checkRateLimitWithInfo(request, "agent-token", 60, 60_000);
  if (limit.response) {
    return oauthError(429, "rate_limited", "Too many requests. Wait and retry.", {
      "Retry-After": limit.response.headers.get("Retry-After") ?? "60",
    });
  }

  const body = await readAgentBody(request, { form: true });
  if (!body || typeof body.grant_type !== "string") {
    return oauthError(400, "invalid_request", "Send grant_type and its parameters.");
  }

  if (body.grant_type === CLAIM_GRANT) {
    return oauthError(
      400,
      "unsupported_grant_type",
      "The claim grant arrives with the claim ceremony in the next release."
    );
  }
  if (body.grant_type !== JWT_BEARER_GRANT) {
    return oauthError(400, "unsupported_grant_type", `Use grant_type ${JWT_BEARER_GRANT}.`);
  }
  if (typeof body.assertion !== "string" || body.assertion.length === 0) {
    return oauthError(400, "invalid_request", "assertion is required.");
  }
  // RFC 8707: the one resource this server issues tokens for.
  if (body.resource !== undefined && body.resource !== `${issuer()}/api/`) {
    return oauthError(400, "invalid_target", `resource must be ${issuer()}/api/.`);
  }

  try {
    if (!(await assertionSigningConfigured())) {
      return oauthError(503, "temporarily_unavailable", "Token issuance is not available.");
    }
    const token = await exchangeAssertion(body.assertion);
    await auditAgentEvent(request, {
      action: "agent.token.issued",
      status: 200,
      targetId: token.registration.id,
      targetUserId: token.registration.user_id,
      metadata: { grant: "jwt-bearer", scope: token.scope },
    });
    return oauthJson({
      access_token: token.accessToken,
      token_type: "Bearer",
      expires_in: token.expiresIn,
      scope: token.scope,
    });
  } catch (error) {
    if (error instanceof InvalidGrantError) {
      return oauthError(400, "invalid_grant", error.description);
    }
    sendError(error instanceof Error ? error : new Error(String(error)));
    return oauthError(500, "server_error", "Token issuance failed. Retry later.");
  }
}
