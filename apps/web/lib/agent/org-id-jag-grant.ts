import { auditAgentEvent, emailDomain } from "@/lib/audit";
import { claimAttemptBlock } from "./claims";
import { MAX_CLAIM_ATTEMPTS, POST_CLAIM_SCOPES } from "./constants";
import { NO_STORE_HEADERS, oauthError, oauthJson } from "./errors";
import { maxAuthAgeSeconds } from "./id-jag";
import { linkOrgIdJag, verifyOrgIdJag } from "./org-id-jag";
import { claimEndpointUrl } from "./registrations";

/**
 * The jwt-bearer grant with an organisation ID-JAG as its assertion
 * (POST /api/oauth2/token; lib/agent/org-id-jag.ts). Answers follow
 * draft-ietf-oauth-identity-assertion-authz-grant Section 4.4.3:
 * invalid_grant for an assertion that failed a check, access_denied for a
 * valid one whose person is not a member of a team trusting the issuer.
 * The first use of an identity answers interaction_required with a claim
 * ceremony (the same block /api/agent/identity hands out); its claim grant
 * returns the account's tokens, and later assertions get a token at once.
 * No refresh token: a fresh assertion is the way to a new access token.
 */

const KIND = "identity_assertion";
const SOURCE = "team_issuer";

function text(body: Record<string, unknown>, key: string, max = 512): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export async function orgIdJagGrant(
  request: Request,
  body: Record<string, unknown>,
  assertion: string
): Promise<Response> {
  const clientId = text(body, "client_id");
  if (!clientId) {
    return oauthError(400, "invalid_request", "client_id is required with an identity assertion.");
  }

  const verified = await verifyOrgIdJag(assertion, clientId);
  if (!verified.ok) {
    await auditAgentEvent(request, {
      action: "agent.registration.refused",
      status: 400,
      metadata: { kind: KIND, source: SOURCE, code: verified.error },
    });
    if (verified.error === "auth_time_missing" || verified.error === "auth_time_too_old") {
      const maxAge = maxAuthAgeSeconds();
      return oauthError(
        400,
        "invalid_grant",
        verified.error === "auth_time_missing"
          ? `The assertion carries no auth_time; the sign-in must be at most ${maxAge}s old.`
          : `auth_time is ${verified.authAge}s old; the sign-in must be at most ${maxAge}s old.`
      );
    }
    return oauthError(400, "invalid_grant", `The assertion was rejected (${verified.error}).`);
  }

  const link = await linkOrgIdJag(verified);
  const refused = async (status: number, code: string, description: string) => {
    await auditAgentEvent(request, {
      action: "agent.registration.refused",
      status,
      metadata: { kind: KIND, source: SOURCE, code, issuer: verified.iss },
    });
    return status === 429
      ? oauthError(429, "rate_limited", description, { "Retry-After": "600" })
      : oauthError(status, "access_denied", description);
  };

  switch (link.status) {
    case "not_member":
      return refused(
        400,
        "not_member",
        "No member of a team that trusts this issuer has this email."
      );
    case "client_not_allowed":
      return refused(
        400,
        "client_not_allowed",
        "The team does not allow this client for its issuer."
      );
    case "identity_mismatch":
      return refused(
        400,
        "identity_mismatch",
        "This identity is connected to another account here, or no longer through a team that trusts the issuer."
      );
    case "email_not_usable":
      return refused(400, "email_not_usable", "The assertion's email cannot be used here.");
    case "too_many_attempts":
      return refused(
        429,
        "too_many_attempts",
        `This identity started ${MAX_CLAIM_ATTEMPTS} confirmations. Wait for the registration to expire.`
      );
    case "too_many_pending":
      return refused(
        429,
        "too_many_pending",
        "Too many agents are waiting for this person already."
      );
    case "interaction_required": {
      const { registration, claimToken, attempt, teamId } = link;
      if (link.created) {
        await auditAgentEvent(request, {
          action: "agent.registration.created",
          status: 200,
          targetId: registration.id,
          teamId,
          metadata: { kind: KIND, source: SOURCE, issuer: verified.iss, linked: false },
        });
      }
      await auditAgentEvent(request, {
        action: "agent.claim.requested",
        status: 200,
        targetId: registration.id,
        teamId,
        metadata: {
          kind: KIND,
          source: SOURCE,
          attempt: attempt.attempt,
          login_hint_domain: emailDomain(verified.email),
        },
      });
      return Response.json(
        {
          error: "interaction_required",
          error_description:
            "The member confirms this agent once. Show the human verification_uri and user_code, then poll with the claim grant.",
          registration_id: registration.id,
          registration_type: KIND,
          claim_url: claimEndpointUrl(),
          claim_token: claimToken,
          claim_token_expires: new Date(registration.expires_at).toISOString(),
          post_claim_scopes: POST_CLAIM_SCOPES,
          claim: claimAttemptBlock(attempt),
        },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    case "linked": {
      const { token, teamId } = link;
      await auditAgentEvent(request, {
        action: "agent.token.issued",
        status: 200,
        targetId: token.registration.id,
        targetUserId: token.registration.user_id,
        teamId,
        metadata: { grant: "jwt-bearer", source: SOURCE, issuer: verified.iss, scope: token.scope },
      });
      return oauthJson({
        access_token: token.accessToken,
        token_type: "Bearer",
        expires_in: token.expiresIn,
        scope: token.scope,
      });
    }
  }
}
