import { createHash } from "node:crypto";
import { auditAgentEvent, emailDomain } from "@/lib/audit";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { claimAttemptBlock } from "./claims";
import { MAX_CLAIM_ATTEMPTS, POST_CLAIM_SCOPES } from "./constants";
import { NO_STORE_HEADERS, oauthError, oauthJson } from "./errors";
import { issuer } from "./http";
import { maxAuthAgeSeconds } from "./id-jag";
import {
  linkOrgIdJag,
  MAX_LIFETIME_WITHOUT_AUTH_TIME_SECS,
  type OrgIdJagLinked,
  verifyOrgIdJag,
} from "./org-id-jag";
import { notifyConnectBound } from "./org-connect-notice";
import { refusalAuditGate } from "./refusal-audit";
import { claimEndpointUrl } from "./registrations";
import { issuerRateKey, ORG_ISSUER_LIMIT } from "./token-rate-limit";

/**
 * The jwt-bearer grant with an organisation ID-JAG as its assertion
 * (POST /api/oauth2/token; lib/agent/org-id-jag.ts). Answers follow
 * draft-ietf-oauth-identity-assertion-authz-grant Section 4.4.3:
 * invalid_grant for an assertion that failed a check, access_denied for a
 * valid one whose person is not a member of a team trusting the issuer.
 * An identity binds at once inside a window the member opened on the team
 * page ("Connect"); outside one, its first use answers interaction_required
 * naming the team page, with a claim ceremony (the same block
 * /api/agent/identity hands out) for agents that relay it. Once bound,
 * later assertions get a token at once. No refresh token: a fresh assertion
 * is the way to a new access token.
 *
 * Rate limits: before the signature is checked, the token route counts an
 * assertion naming an issuer under a configured prefix per address and per
 * (issuer, address) (lib/agent/token-rate-limit.ts), so one address can
 * spend only its own budget. Once the signature holds, it is counted here
 * against the issuer's shared budget (600 a minute, which only the issuer's
 * own signed assertions can spend) and per identity (iss, sub), 30 a minute.
 *
 * Until the signature holds, every refusal is the same invalid_grant
 * answer: whether the issuer is under a prefix, trusted by some team, or
 * publishes keys stays out of the body. Not out of the timing: an issuer no
 * team trusts is refused after a cached lookup, a trusted one only after
 * its keys were read (fetched, when not cached), so response times can tell
 * the two apart. The issuer URLs are an organisation's own, not secrets,
 * and knowing that some team trusts one gives nothing without its signing
 * key. The audit row keeps the reason, at most one a minute per address and
 * code (lib/agent/refusal-audit.ts).
 */

const KIND = "identity_assertion";
/** The one answer to an assertion whose signature did not hold. */
export const UNVERIFIED_DESCRIPTION = "The assertion could not be verified.";
const SOURCE = "team_issuer";
/** Verified assertions one identity may present a minute. */
export const IDENTITY_RATE_LIMIT = 30;

/** The rate-limit key of a verified identity; never the raw sub. */
export function identityRateKey(iss: string, sub: string): string {
  return `agent-token-org-identity:${createHash("sha256").update(`${iss}#${sub}`).digest("hex")}`;
}

/** The team page, where a member opens a window to connect. */
export function teamConnectUrl(teamId: string): string {
  return `${issuer()}/teams/${encodeURIComponent(teamId)}#agent-sign-in`;
}

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
    if (!verified.signed) {
      // Anyone can send these: at most one row a minute per address and
      // code, carrying the count of the ones in between.
      const gate = refusalAuditGate(request, verified.error);
      if (gate.record) {
        await auditAgentEvent(request, {
          action: "agent.registration.refused",
          status: 400,
          metadata: {
            kind: KIND,
            source: SOURCE,
            code: verified.error,
            ...(gate.suppressed > 0 ? { suppressed: gate.suppressed } : {}),
          },
        });
      }
      return oauthError(400, "invalid_grant", UNVERIFIED_DESCRIPTION);
    }
    // Signed refusals are the issuer's own and paced by its budgets below
    // and the jti: each is recorded.
    await auditAgentEvent(request, {
      action: "agent.registration.refused",
      status: 400,
      metadata: { kind: KIND, source: SOURCE, code: verified.error },
    });
    if (verified.error === "auth_time_too_old") {
      return oauthError(
        400,
        "invalid_grant",
        `auth_time is ${verified.authAge}s old; the sign-in must be at most ${maxAuthAgeSeconds()}s old.`
      );
    }
    if (verified.error === "lifetime_too_long") {
      return oauthError(
        400,
        "invalid_grant",
        `The assertion carries no auth_time, so exp - iat must be at most ${MAX_LIFETIME_WITHOUT_AUTH_TIME_SECS}s.`
      );
    }
    return oauthError(400, "invalid_grant", `The assertion was rejected (${verified.error}).`);
  }

  // The issuer's shared budget, which only its signed assertions reach.
  const issuerPace = await checkRateLimitByKeyWithInfo(
    issuerRateKey(verified.iss),
    ORG_ISSUER_LIMIT,
    60_000
  );
  if (issuerPace.response) {
    return oauthError(429, "rate_limited", "Too many requests for this issuer. Wait and retry.", {
      "Retry-After": issuerPace.response.headers.get("Retry-After") ?? "60",
    });
  }
  // Per identity, now that it is known to be real.
  const pace = await checkRateLimitByKeyWithInfo(
    identityRateKey(verified.iss, verified.sub),
    IDENTITY_RATE_LIMIT,
    60_000
  );
  if (pace.response) {
    return oauthError(429, "rate_limited", "Too many requests for this identity. Wait and retry.", {
      "Retry-After": pace.response.headers.get("Retry-After") ?? "60",
    });
  }

  // Recorded, and the member emailed, as soon as the database has bound the
  // identity: a failure to mint the token afterwards must not hide a
  // connection that now exists. Neither call throws.
  const recordLink = async ({
    registration,
    teamId,
    bound,
    trustId,
    windowsClosed,
  }: OrgIdJagLinked) => {
    if (bound) {
      await auditAgentEvent(request, {
        action: "team.idjag_connect_bound",
        status: 200,
        targetId: registration.id,
        targetUserId: registration.user_id,
        teamId,
        metadata: {
          source: SOURCE,
          issuer: verified.iss,
          trust_id: trustId,
          client: registration.client_name,
        },
      });
      // No code was compared, so the member hears what connected.
      if (registration.user_id) {
        await notifyConnectBound({
          userId: registration.user_id,
          teamId,
          clientName: registration.client_name,
          issuer: verified.iss,
        });
      }
    }
    // A window the member opened while this identity was connected
    // already: closed by the link, so no other identity binds in it.
    for (const closed of windowsClosed) {
      await auditAgentEvent(request, {
        action: "team.idjag_connect_closed",
        status: 200,
        targetId: closed.trustId,
        targetUserId: registration.user_id,
        teamId: closed.teamId,
        metadata: {
          source: SOURCE,
          issuer: verified.iss,
          reason: "already_connected",
          registration_id: registration.id,
        },
      });
    }
  };

  const link = await linkOrgIdJag(verified, { linked: recordLink });
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
    case "too_many_agents":
      return refused(
        400,
        "too_many_agents",
        "The member has as many connected agents as allowed. Disconnect one first."
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
          error_description: teamId
            ? `Not connected yet. The member opens ${teamConnectUrl(teamId)}, chooses Connect next to the issuer, and the agent tries again within 10 minutes. An agent that can show the human a link may instead show verification_uri and user_code and poll with the claim grant.`
            : "The member confirms this agent once. Show the human verification_uri and user_code, then poll with the claim grant.",
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
