import { checkRateLimitByKeyWithInfo, checkRateLimitWithInfo } from "@/lib/rate-limit";
import { auditAgentEvent } from "@/lib/audit";
import { assertionSigningConfigured } from "@/lib/agent/assertion";
import { pollClaim } from "@/lib/agent/claims";
import {
  AUTHORIZATION_CODE_GRANT,
  CLAIM_GRANT,
  CLAIM_POLL_INTERVAL_SECONDS,
  JWT_BEARER_GRANT,
  REFRESH_TOKEN_GRANT,
} from "@/lib/agent/constants";
import { oauthError, oauthJson } from "@/lib/agent/errors";
import { issuer, readAgentBody } from "@/lib/agent/http";
import { exchangeAssertion, hashClaimToken, InvalidGrantError } from "@/lib/agent/registrations";
import { preflight, withCors } from "@/lib/oauth/cors";
import {
  OAuthGrantError,
  redeemAuthorizationCode,
  refreshTokens,
  type OAuthTokens,
} from "@/lib/oauth/tokens";
import { reportError } from "@/lib/observability";

/**
 * POST /api/oauth2/token. Four grants:
 *   - jwt-bearer (RFC 7523, auth.md Step 5) exchanges a registration's
 *     identity assertion for a one-hour access token;
 *   - the claim grant (auth.md Step 4c) is the agent's poll during a claim
 *     ceremony, in RFC 8628's vocabulary, and on success returns account
 *     credentials plus a claimed identity assertion;
 *   - authorization_code (with PKCE) and refresh_token are OAuth 2.1 for
 *     remote MCP clients (lib/oauth).
 * Form-encoded per RFC 6749; JSON is accepted too. Answers use the RFC 6749
 * error envelope, are never cached, and carry CORS headers for browser
 * clients.
 */
export async function POST(request: Request) {
  return withCors(await token(request));
}

export function OPTIONS() {
  return preflight();
}

async function token(request: Request): Promise<Response> {
  const body = await readAgentBody(request, { form: true });
  if (!body || typeof body.grant_type !== "string") {
    return oauthError(400, "invalid_request", "Send grant_type and its parameters.");
  }

  // Hosted MCP clients (claude.ai, ChatGPT) refresh for many users from few
  // addresses; their codes and refresh tokens cannot be guessed, so they
  // get a wider budget than the agent grants.
  const oauthGrant =
    body.grant_type === AUTHORIZATION_CODE_GRANT || body.grant_type === REFRESH_TOKEN_GRANT;
  const limit = oauthGrant
    ? await checkRateLimitWithInfo(request, "oauth-token", 600, 60_000)
    : await checkRateLimitWithInfo(request, "agent-token", 60, 60_000);
  if (limit.response) {
    return oauthError(429, "rate_limited", "Too many requests. Wait and retry.", {
      "Retry-After": limit.response.headers.get("Retry-After") ?? "60",
    });
  }

  if (oauthGrant) {
    return oauthTokenGrant(request, body);
  }
  if (body.grant_type === CLAIM_GRANT) {
    return claimGrant(request, body);
  }
  if (body.grant_type !== JWT_BEARER_GRANT) {
    return oauthError(
      400,
      "unsupported_grant_type",
      `Use grant_type ${AUTHORIZATION_CODE_GRANT}, ${REFRESH_TOKEN_GRANT}, ${JWT_BEARER_GRANT} or ${CLAIM_GRANT}.`
    );
  }
  if (typeof body.assertion !== "string" || body.assertion.length === 0) {
    return oauthError(400, "invalid_request", "assertion is required.");
  }
  // RFC 8707: the API, or the MCP server in front of it; the token is the same.
  if (
    body.resource !== undefined &&
    body.resource !== `${issuer()}/api/` &&
    body.resource !== `${issuer()}/mcp`
  ) {
    return oauthError(
      400,
      "invalid_target",
      `resource must be ${issuer()}/api/ or ${issuer()}/mcp.`
    );
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
    reportError("POST /api/oauth2/token failed", error);
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
    reportError("POST /api/oauth2/token claim grant failed", error);
    return oauthError(500, "server_error", "Token issuance failed. Retry later.");
  }
}

function text(body: Record<string, unknown>, key: string, max = 2048): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** authorization_code and refresh_token, for public OAuth clients. */
async function oauthTokenGrant(request: Request, body: Record<string, unknown>): Promise<Response> {
  const clientId = text(body, "client_id");
  if (!clientId) {
    return oauthError(400, "invalid_request", "client_id is required for public clients.");
  }
  // RFC 8707: tokens are for the MCP server and the API, nothing else.
  const resource = text(body, "resource");
  const app = issuer();
  if (resource && ![`${app}/mcp`, `${app}/mcp/`, `${app}/api/`, `${app}/api`].includes(resource)) {
    return oauthError(400, "invalid_target", `resource must be ${app}/mcp or ${app}/api/.`);
  }

  try {
    let tokens: OAuthTokens;
    if (body.grant_type === AUTHORIZATION_CODE_GRANT) {
      const code = text(body, "code", 128);
      const redirectUri = text(body, "redirect_uri");
      const codeVerifier = text(body, "code_verifier", 128);
      if (!code || !redirectUri || !codeVerifier) {
        return oauthError(
          400,
          "invalid_request",
          "code, redirect_uri and code_verifier are required."
        );
      }
      tokens = await redeemAuthorizationCode({ code, clientId, redirectUri, codeVerifier });
    } else {
      const refreshToken = text(body, "refresh_token", 128);
      if (!refreshToken) {
        return oauthError(400, "invalid_request", "refresh_token is required.");
      }
      tokens = await refreshTokens({ refreshToken, clientId });
    }

    await auditAgentEvent(request, {
      action: "agent.token.issued",
      status: 200,
      targetId: tokens.registration.id,
      targetUserId: tokens.registration.user_id,
      metadata: { grant: body.grant_type, scope: tokens.scope },
    });
    return oauthJson({
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      refresh_token: tokens.refresh_token,
    });
  } catch (error) {
    if (error instanceof OAuthGrantError) {
      return oauthError(400, error.code, error.description);
    }
    reportError("POST /api/oauth2/token OAuth grant failed", error);
    return oauthError(500, "server_error", "Token issuance failed. Retry later.");
  }
}
