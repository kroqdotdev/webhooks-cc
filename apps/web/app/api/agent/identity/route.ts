import { sendError } from "@appsignal/nodejs";
import { serverEnv } from "@/lib/env";
import {
  applyRateLimitHeaders,
  checkRateLimitByKeyWithInfo,
  checkRateLimitWithInfo,
  checkWideRateLimitWithInfo,
} from "@/lib/rate-limit";
import { auditAgentEvent, emailDomain } from "@/lib/audit";
import { assertionSigningConfigured } from "@/lib/agent/assertion";
import {
  ID_JAG_ASSERTION_TYPE,
  POST_CLAIM_SCOPES,
  PRE_CLAIM_SCOPES,
  SANDBOX_MAX_ENDPOINTS,
  SANDBOX_REQUEST_BUDGET,
  SANDBOX_REQUESTS_PER_ENDPOINT,
  UNCLAIMED_LIFETIME_SECONDS,
} from "@/lib/agent/constants";
import {
  AgentError,
  agentError,
  agentErrorResponse,
  rateLimitedResponse,
} from "@/lib/agent/errors";
import {
  anonymousRegistrationUnavailable,
  challengeEndpointUrl,
  issuer,
  newRegistrationChallenge,
  powSecrets,
  readAgentBody,
} from "@/lib/agent/http";
import {
  claimAttemptBlock,
  createServiceAuthRegistration,
  normalizeLoginHint,
} from "@/lib/agent/claims";
import { linkIdJagIdentity } from "@/lib/agent/delegations";
import { maxAuthAgeSeconds, verifyIdJag } from "@/lib/agent/id-jag";
import { verifySolution } from "@/lib/agent/pow";
import {
  claimEndpointUrl,
  cleanClientName,
  createAnonymousRegistration,
  powChallengeUsed,
  sandboxEndpointsUrl,
} from "@/lib/agent/registrations";

/**
 * POST /api/agent/identity: agent registration (auth.md v0.6, Step 3).
 *
 *   - anonymous: needs a solved proof-of-work challenge (our extension);
 *     returns an identity assertion for the sandbox and a claim token.
 *   - service_auth: the agent names its human's email and gets a claim
 *     attempt; nothing works until that human completes it signed in.
 *   - identity_assertion (ID-JAG): only for trusted providers, of which
 *     production has none. A sign-in at the provider older than
 *     AGENT_IDJAG_MAX_AUTH_AGE_SECONDS answers login_required; an identity
 *     whose email belongs to an existing account answers
 *     interaction_required with a claim attempt until its human confirms.
 *
 * Errors are `{ error, error_description }` with auth.md's codes.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Challenges handed out inline when a registration arrives without one. */
const CHALLENGE_RATE_LIMIT = 30;
const CHALLENGE_RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  const body = await readAgentBody(request);
  if (!body) {
    return agentError(400, "invalid_request", "Send a JSON object with a `type`.");
  }

  try {
    switch (body.type) {
      case "anonymous":
        return await registerAnonymous(request, body);
      case "identity_assertion":
        return await registerIdJag(request, body);
      case "service_auth":
        return await registerServiceAuth(request, body);
      default:
        return agentError(
          400,
          "invalid_request",
          "`type` must be anonymous, service_auth or identity_assertion."
        );
    }
  } catch (error) {
    if (error instanceof AgentError) return agentErrorResponse(error);
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Registration failed. Retry later.");
  }
}

async function registerAnonymous(
  request: Request,
  body: Record<string, unknown>
): Promise<Response> {
  const unavailable = await anonymousRegistrationUnavailable();
  if (unavailable) return agentErrorResponse(unavailable);
  const env = serverEnv();
  const clientName = cleanClientName(body.client_name);

  // No proof yet: hand out a challenge, so an agent that skipped discovery
  // registers in two calls. Counted against the challenge limit, not the
  // registration limit.
  if (body.proof_of_work === undefined) {
    const limit = await checkRateLimitWithInfo(
      request,
      "agent-challenge",
      CHALLENGE_RATE_LIMIT,
      CHALLENGE_RATE_WINDOW_MS
    );
    if (limit.response) return rateLimitedResponse(limit.response);
    return agentError(
      400,
      "proof_of_work_required",
      "Solve this challenge and send the nonces as proof_of_work. See /auth.md.",
      { ...(await newRegistrationChallenge()), challenge_endpoint: challengeEndpointUrl() }
    );
  }

  const perIp = await checkRateLimitWithInfo(
    request,
    "agent-identity",
    env.AGENT_REGISTER_RATE_LIMIT,
    env.AGENT_REGISTER_RATE_WINDOW_MS
  );
  if (perIp.response) return rateLimitedResponse(perIp.response);
  const wide = await checkWideRateLimitWithInfo(
    request,
    "agent-identity",
    env.AGENT_REGISTER_WIDE_RATE_LIMIT,
    HOUR_MS
  );
  if (wide.response) return rateLimitedResponse(wide.response);

  const pow = body.proof_of_work as Record<string, unknown> | null;
  const verified = verifySolution({
    challenge: pow && typeof pow === "object" ? pow.challenge : undefined,
    nonces: pow && typeof pow === "object" ? pow.nonces : undefined,
    secrets: powSecrets(),
    audience: issuer(),
  });
  if (!verified.ok) {
    return refuseChallenge(
      request,
      verified.reason,
      `The proof of work was not accepted (${verified.reason}). Solve this new challenge.`
    );
  }

  // A replayed challenge is refused before the global rate, which only
  // counts fresh work: one solved challenge must not use it up.
  if (await powChallengeUsed(verified.id)) {
    return refuseChallenge(
      request,
      "replayed",
      "This proof-of-work challenge was already used. Solve this new challenge."
    );
  }

  // Counted only for verified work, so unsolved requests cannot use it up.
  const global = await checkRateLimitByKeyWithInfo(
    "agent-identity:anonymous:global",
    env.AGENT_ANONYMOUS_GLOBAL_RATE,
    HOUR_MS
  );
  if (global.response) {
    await auditAgentEvent(request, {
      action: "agent.registration.refused",
      status: 429,
      metadata: { kind: "anonymous", code: "global_rate" },
    });
    return rateLimitedResponse(global.response);
  }

  let created;
  try {
    created = await createAnonymousRegistration({
      clientName,
      powChallengeId: verified.id,
    });
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    await auditAgentEvent(request, {
      action: "agent.registration.refused",
      status: error.status,
      metadata: { kind: "anonymous", code: error.code },
    });
    // A concurrent replay lost the insert: a fresh challenge, like any other refused proof.
    if (error.code === "invalid_challenge") {
      return agentError(error.status, error.code, error.description, {
        ...(await newRegistrationChallenge()),
        challenge_endpoint: challengeEndpointUrl(),
      });
    }
    throw error;
  }

  const { registration, claimToken, assertion, sandboxFull } = created;
  await auditAgentEvent(request, {
    action: "agent.registration.created",
    status: 200,
    targetId: registration.id,
    metadata: {
      kind: "anonymous",
      client_name: clientName,
      pow_difficulty: verified.difficulty,
      pow_count: verified.count,
    },
  });

  const expires = new Date(registration.expires_at).toISOString();
  return applyRateLimitHeaders(
    Response.json(
      {
        registration_id: registration.id,
        registration_type: "anonymous",
        identity_assertion: assertion,
        assertion_expires: expires,
        pre_claim_scopes: PRE_CLAIM_SCOPES,
        claim_url: claimEndpointUrl(),
        claim_token: claimToken,
        claim_token_expires: expires,
        post_claim_scopes: POST_CLAIM_SCOPES,
        sandbox: {
          status: sandboxFull ? "full" : "available",
          endpoints_url: sandboxEndpointsUrl(),
          lifetime_seconds: UNCLAIMED_LIFETIME_SECONDS,
          max_endpoints: SANDBOX_MAX_ENDPOINTS,
          max_requests_per_endpoint: SANDBOX_REQUESTS_PER_ENDPOINT,
          max_requests: SANDBOX_REQUEST_BUDGET,
        },
        // The same values in the nested shape of the auth.md v0.7 proposal,
        // so clients written against it can register and use the sandbox.
        id: registration.id,
        type: "anonymous",
        identity: { assertion, expires_at: expires },
        claim: { token: claimToken, expires_at: expires, url: claimEndpointUrl() },
        scopes: { pre_claim: PRE_CLAIM_SCOPES, post_claim: POST_CLAIM_SCOPES },
      },
      { headers: { "Cache-Control": "no-store" } }
    ),
    perIp
  );
}

/** 400 invalid_challenge with a fresh challenge, recorded in the audit trail. */
async function refuseChallenge(
  request: Request,
  reason: string,
  description: string
): Promise<Response> {
  await auditAgentEvent(request, {
    action: "agent.registration.refused",
    status: 400,
    metadata: { kind: "anonymous", code: "invalid_challenge", reason },
  });
  return agentError(400, "invalid_challenge", description, {
    ...(await newRegistrationChallenge()),
    challenge_endpoint: challengeEndpointUrl(),
  });
}

async function registerServiceAuth(
  request: Request,
  body: Record<string, unknown>
): Promise<Response> {
  const env = serverEnv();
  const limit = await checkRateLimitWithInfo(
    request,
    "agent-identity-service-auth",
    env.AGENT_REGISTER_RATE_LIMIT,
    env.AGENT_REGISTER_RATE_WINDOW_MS
  );
  if (limit.response) return rateLimitedResponse(limit.response);

  const loginHint = normalizeLoginHint(body.login_hint);
  const clientName = cleanClientName(body.client_name);
  let created;
  try {
    created = await createServiceAuthRegistration({ loginHint, clientName });
  } catch (error) {
    if (error instanceof AgentError) {
      await auditAgentEvent(request, {
        action: "agent.registration.refused",
        status: error.status,
        metadata: { kind: "service_auth", code: error.code },
      });
    }
    throw error;
  }

  const { registration, claimToken, attempt } = created;
  await auditAgentEvent(request, {
    action: "agent.registration.created",
    status: 200,
    targetId: registration.id,
    metadata: { kind: "service_auth", client_name: clientName },
  });
  await auditAgentEvent(request, {
    action: "agent.claim.requested",
    status: 200,
    targetId: registration.id,
    metadata: { kind: "service_auth", attempt: 1, login_hint_domain: emailDomain(loginHint) },
  });

  return applyRateLimitHeaders(
    Response.json(
      {
        registration_id: registration.id,
        registration_type: "service_auth",
        claim_url: claimEndpointUrl(),
        claim_token: claimToken,
        claim_token_expires: new Date(registration.expires_at).toISOString(),
        post_claim_scopes: POST_CLAIM_SCOPES,
        claim: claimAttemptBlock(attempt),
      },
      { headers: { "Cache-Control": "no-store" } }
    ),
    limit
  );
}

async function registerIdJag(request: Request, body: Record<string, unknown>): Promise<Response> {
  const env = serverEnv();
  const limit = await checkRateLimitWithInfo(
    request,
    "agent-identity-idjag",
    env.AGENT_IDJAG_RATE_LIMIT,
    env.AGENT_REGISTER_RATE_WINDOW_MS
  );
  if (limit.response) return rateLimitedResponse(limit.response);

  if (body.assertion_type !== ID_JAG_ASSERTION_TYPE || typeof body.assertion !== "string") {
    return agentError(
      400,
      "invalid_request",
      `identity_assertion needs assertion_type ${ID_JAG_ASSERTION_TYPE} and an assertion.`
    );
  }

  const verified = await verifyIdJag(body.assertion);
  if (!verified.ok) {
    if (verified.error === "invalid_issuer") {
      return agentError(
        400,
        "issuer_not_enabled",
        "This identity provider is not trusted here. Register anonymously instead."
      );
    }
    if (verified.error === "auth_time_missing" || verified.error === "auth_time_too_old") {
      const maxAge = maxAuthAgeSeconds();
      const description =
        verified.error === "auth_time_missing"
          ? `The ID-JAG carries no auth_time; max allowed age is ${maxAge}s. Re-authenticate at the provider and request a fresh ID-JAG.`
          : `auth_time is ${verified.authAge}s old; max allowed is ${maxAge}s. Re-authenticate at the provider and request a fresh ID-JAG.`;
      return agentError(
        401,
        "login_required",
        description,
        { max_age: maxAge },
        {
          "WWW-Authenticate": `AgentAuth error="login_required", max_age="${maxAge}", error_description="${description}"`,
        }
      );
    }
    return agentError(400, "invalid_request", `The assertion was rejected (${verified.error}).`);
  }
  if (!(await assertionSigningConfigured())) {
    return agentError(503, "temporarily_unavailable", "Agent registration is not available.");
  }

  let link;
  try {
    link = await linkIdJagIdentity(verified);
  } catch (error) {
    if (error instanceof AgentError) {
      await auditAgentEvent(request, {
        action: "agent.registration.refused",
        status: error.status,
        metadata: { kind: "identity_assertion", code: error.code, issuer: verified.iss },
      });
    }
    throw error;
  }

  if (link.status === "interaction_required") {
    const { registration, claimToken, attempt } = link;
    if (link.created) {
      // State changes that succeeded; the 401 asks the human to confirm them.
      await auditAgentEvent(request, {
        action: "agent.registration.created",
        status: 200,
        targetId: registration.id,
        metadata: { kind: "identity_assertion", issuer: verified.iss, linked: false },
      });
    }
    await auditAgentEvent(request, {
      action: "agent.claim.requested",
      status: 200,
      targetId: registration.id,
      metadata: {
        kind: "identity_assertion",
        attempt: attempt.attempt,
        login_hint_domain: emailDomain(registration.attempt_login_hint ?? ""),
      },
    });
    const description =
      "This identity's email belongs to an existing webhooks.cc account. Show the human verification_uri and user_code, then poll the claim grant.";
    return applyRateLimitHeaders(
      Response.json(
        {
          error: "interaction_required",
          error_description: description,
          registration_id: registration.id,
          registration_type: "identity_assertion",
          claim_url: claimEndpointUrl(),
          claim_token: claimToken,
          claim_token_expires: new Date(registration.expires_at).toISOString(),
          post_claim_scopes: POST_CLAIM_SCOPES,
          claim: claimAttemptBlock(attempt),
        },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
            "WWW-Authenticate": `AgentAuth error="interaction_required", error_description="${description}"`,
          },
        }
      ),
      limit
    );
  }

  if (link.created) {
    await auditAgentEvent(request, {
      action: "agent.registration.created",
      status: 200,
      targetId: link.registration.id,
      targetUserId: link.registration.user_id,
      metadata: {
        kind: "identity_assertion",
        issuer: verified.iss,
        linked: true,
        account_created: link.provisioned,
      },
    });
  }
  return applyRateLimitHeaders(
    Response.json(
      {
        registration_id: link.registration.id,
        registration_type: "identity_assertion",
        identity_assertion: link.assertion,
        assertion_expires: link.assertionExpires.toISOString(),
        scopes: POST_CLAIM_SCOPES,
      },
      { headers: { "Cache-Control": "no-store" } }
    ),
    limit
  );
}
