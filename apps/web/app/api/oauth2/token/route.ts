import { sendError } from "@appsignal/nodejs";
import { checkRateLimitByKeyWithInfo, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { auditAgentEvent } from "@/lib/audit";
import { assertionSigningConfigured } from "@/lib/agent/assertion";
import { pollClaim } from "@/lib/agent/claims";
import { CLAIM_GRANT, CLAIM_POLL_INTERVAL_SECONDS, JWT_BEARER_GRANT } from "@/lib/agent/constants";
import { oauthError, oauthJson } from "@/lib/agent/errors";
import { issuer, readAgentBody } from "@/lib/agent/http";
import { exchangeAssertion, hashClaimToken, InvalidGrantError } from "@/lib/agent/registrations";

/**
 * POST /api/oauth2/token. Two grants:
 *   - jwt-bearer (RFC 7523, auth.md Step 5) exchanges a registration's
 *     identity assertion for a one-hour access token;
 *   - the claim grant (auth.md Step 4c) is the agent's poll during a claim
 *     ceremony, in RFC 8628's vocabulary, and on success returns account
 *     credentials plus a claimed identity assertion.
 * Form-encoded per RFC 6749; JSON is accepted too. Answers use the RFC 6749
 * error envelope and are never cached.
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
    return claimGrant(request, body);
  }
  if (body.grant_type !== JWT_BEARER_GRANT) {
    return oauthError(
      400,
      "unsupported_grant_type",
      `Use grant_type ${JWT_BEARER_GRANT} or ${CLAIM_GRANT}.`
    );
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

async function claimGrant(request: Request, body: Record<string, unknown>): Promise<Response> {
  const claimToken = body.claim_token;
  if (typeof claimToken !== "string" || !claimToken.startsWith("clm_") || claimToken.length > 64) {
    return oauthError(400, "invalid_request", "claim_token is required.");
  }
  // One poll per interval per claim token (RFC 8628 3.5).
  const pace = await checkRateLimitByKeyWithInfo(
    `agent-claim-poll:${hashClaimToken(claimToken)}`,
    1,
    CLAIM_POLL_INTERVAL_SECONDS * 1000
  );
  if (pace.response) {
    return oauthError(
      400,
      "slow_down",
      `Poll at most every ${CLAIM_POLL_INTERVAL_SECONDS} seconds.`
    );
  }

  try {
    if (!(await assertionSigningConfigured())) {
      return oauthError(503, "temporarily_unavailable", "Token issuance is not available.");
    }
    const result = await pollClaim(claimToken);
    switch (result.status) {
      case "pending":
        return oauthError(400, "authorization_pending", "The human has not entered the code yet.");
      case "expired":
        return oauthError(
          400,
          "expired_token",
          "The code or the registration expired. Start a new attempt at the claim endpoint."
        );
      case "denied":
        return oauthError(400, "access_denied", "The human declined the request.");
      case "invalid":
        return oauthError(400, "invalid_grant", result.description);
      case "claimed":
        await auditAgentEvent(request, {
          action: "agent.token.issued",
          status: 200,
          targetId: result.registration.id,
          targetUserId: result.registration.user_id,
          metadata: { grant: "claim", scope: result.token.scope },
        });
        return oauthJson({
          access_token: result.token.accessToken,
          token_type: "Bearer",
          expires_in: result.token.expiresIn,
          scope: result.token.scope,
          identity_assertion: result.assertion,
          assertion_expires: result.assertionExpires.toISOString(),
        });
    }
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return oauthError(500, "server_error", "Token issuance failed. Retry later.");
  }
}
