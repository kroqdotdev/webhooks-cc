import { checkRateLimitWithInfo, applyRateLimitHeaders } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { serverEnv } from "@/lib/env";
import { AgentRequestError, issueVerifiedEmailClaim } from "@/lib/agent/agent-auth";
import { deprecated, endpointMoved } from "@/lib/agent/legacy";
import { isCaptureDomainAddress } from "@/lib/email-capture";
import { auditAgentEvent, emailDomain } from "@/lib/audit";
import { isPlainEmailAddress } from "@/lib/request-validation";
import { sendError } from "@appsignal/nodejs";

/**
 * The auth.md v0.1 registration endpoint. Only `verified_email` still works
 * here, deprecated until its sunset (VERIFIED_EMAIL_SUNSET_AT): it needs a
 * human to read an emailed code and never reaches the sandbox. Anonymous and ID-JAG registration moved to
 * POST /api/agent/identity (auth.md v0.6) and answer 410 with a pointer to
 * /auth.md: legacy anonymous keys would skip the proof of work and the
 * sandbox pool.
 */

const VERIFIED_EMAIL_ASSERTION_TYPE = "verified_email";

/** Request body size cap. */
const MAX_BODY_BYTES = 16 * 1024;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function optionalClientName(body: Record<string, unknown>): string | undefined {
  return isString(body.client_name) ? body.client_name : undefined;
}

const MOVED =
  "Agent registration moved to auth.md v0.6: POST /api/agent/identity. Read /auth.md for the flow.";

export async function POST(request: Request) {
  // The v0.1 ID-JAG flow accepted the raw assertion as the body.
  if ((request.headers.get("content-type") ?? "").includes("application/jwt")) {
    return endpointMoved(MOVED);
  }
  const parsed = await parseJsonBody(request, MAX_BODY_BYTES);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;

  // The flow is selected by `type`; accept the `identity_type` alias too.
  const flowType = isString(body.type)
    ? body.type
    : isString(body.identity_type)
      ? body.identity_type
      : undefined;

  const isVerifiedEmailFlow =
    flowType === "verified_email" ||
    (flowType === "identity_assertion" && body.assertion_type === VERIFIED_EMAIL_ASSERTION_TYPE);
  if (!isVerifiedEmailFlow) {
    if (flowType === "anonymous" || flowType === "identity_assertion") {
      return endpointMoved(MOVED);
    }
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const rateLimit = await checkRateLimitWithInfo(
    request,
    "agent-register",
    serverEnv().AGENT_REGISTER_RATE_LIMIT,
    serverEnv().AGENT_REGISTER_RATE_WINDOW_MS
  );
  if (rateLimit.response) {
    return rateLimit.response;
  }

  try {
    const emailValue = isString(body.assertion)
      ? body.assertion
      : isString(body.email)
        ? body.email
        : null;
    // Bound length before the regex so worst-case backtracking is capped (ReDoS guard).
    if (!emailValue || !isPlainEmailAddress(emailValue)) {
      return Response.json({ error: "invalid_email" }, { status: 400 });
    }
    // Codes sent to the capture domain can be read through webhooks.cc
    // itself, so one account could verify any number of +tag addresses and
    // mint a new account for each.
    if (isCaptureDomainAddress(emailValue, serverEnv().EMAIL_CAPTURE_DOMAIN)) {
      await auditAgentEvent(request, {
        action: "agent.registration.refused",
        status: 400,
        metadata: { flow: "verified_email", code: "capture_domain" },
      });
      return Response.json(
        {
          error: "invalid_email",
          error_description: `Addresses at ${serverEnv().EMAIL_CAPTURE_DOMAIN} cannot be used to register`,
        },
        { status: 400 }
      );
    }
    const claim = await issueVerifiedEmailClaim({
      email: emailValue,
      clientName: optionalClientName(body),
    });
    await auditAgentEvent(request, {
      action: "agent.claim.requested",
      status: 200,
      targetId: claim.registration_id,
      metadata: {
        flow: "verified_email",
        email_domain: emailDomain(emailValue),
        client_name: optionalClientName(body) ?? null,
      },
    });
    return deprecated(
      applyRateLimitHeaders(
        Response.json(
          {
            registration_id: claim.registration_id,
            registration_type: claim.registration_type,
            claim_url: claim.claim_url,
            claim_token: claim.claim_token,
            claim_token_expires: claim.claim_token_expires,
            post_claim_scopes: claim.post_claim_scopes,
          },
          { status: 200 }
        ),
        rateLimit
      )
    );
  } catch (err) {
    // Capacity/throttle limits surface as their own status + auth.md code.
    if (err instanceof AgentRequestError) {
      await auditAgentEvent(request, {
        action: "agent.registration.refused",
        status: err.status,
        metadata: { flow: flowType ?? null, code: err.code },
      });
      return applyRateLimitHeaders(
        Response.json({ error: err.code }, { status: err.status }),
        rateLimit
      );
    }
    sendError(err instanceof Error ? err : new Error(String(err)));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
