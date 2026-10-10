import { sendError } from "@appsignal/nodejs";
import { serverEnv } from "@/lib/env";
import {
  applyRateLimitHeaders,
  checkRateLimitByKeyWithInfo,
  checkRateLimitWithInfo,
  checkWideRateLimitWithInfo,
} from "@/lib/rate-limit";
import { auditAgentEvent } from "@/lib/audit";
import { AgentRequestError, resolveOrProvisionUser } from "@/lib/agent/agent-auth";
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
import { verifyIdJag } from "@/lib/agent/id-jag";
import { verifySolution } from "@/lib/agent/pow";
import {
  claimEndpointUrl,
  cleanClientName,
  createAnonymousRegistration,
  createIdJagRegistration,
  powChallengeUsed,
  sandboxEndpointsUrl,
} from "@/lib/agent/registrations";

/**
 * POST /api/agent/identity: agent registration (auth.md v0.6, Step 3).
 *
 *   - anonymous: needs a solved proof-of-work challenge (our extension);
 *     returns an identity assertion for the sandbox and a claim token.
 *   - identity_assertion (ID-JAG): only for trusted providers, of which
 *     production has none.
 *   - service_auth: arrives with the claim ceremony.
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
        return agentError(
          400,
          "service_auth_not_enabled",
          "service_auth arrives with the next release. Register anonymously to use the sandbox until then."
        );
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
    return agentError(400, "invalid_request", `The assertion was rejected (${verified.error}).`);
  }
  if (!(await assertionSigningConfigured())) {
    return agentError(503, "temporarily_unavailable", "Agent registration is not available.");
  }

  let created;
  try {
    created = await createIdJagRegistration(verified, resolveOrProvisionUser);
  } catch (error) {
    if (error instanceof AgentRequestError) {
      return agentError(400, "invalid_request", "The assertion's email cannot be used here.");
    }
    throw error;
  }

  await auditAgentEvent(request, {
    action: "agent.registration.created",
    status: 200,
    targetId: created.registration.id,
    targetUserId: created.registration.user_id,
    metadata: { kind: "identity_assertion", issuer: verified.iss },
  });
  return applyRateLimitHeaders(
    Response.json(
      {
        registration_id: created.registration.id,
        registration_type: "identity_assertion",
        identity_assertion: created.assertion,
        assertion_expires: created.assertionExpires.toISOString(),
        scopes: POST_CLAIM_SCOPES,
      },
      { headers: { "Cache-Control": "no-store" } }
    ),
    limit
  );
}
