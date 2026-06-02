import { checkRateLimitWithInfo, applyRateLimitHeaders } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { serverEnv } from "@/lib/env";
import {
  AgentRequestError,
  createAnonymousRegistration,
  issueVerifiedEmailClaim,
  issueIdJagCredential,
} from "@/lib/agent/agent-auth";
import { verifyIdJag } from "@/lib/agent/id-jag";
import { sendError } from "@appsignal/nodejs";

/**
 * Agent self-registration dispatcher (WorkOS auth.md). One POST endpoint backs
 * all three registration flows, selected by `body.type`:
 *
 *   - anonymous           — mint an unowned whcc_ key immediately (returned now).
 *   - verified_email      — issue an OTP; the credential is withheld until the
 *                           OTP is confirmed at the claim ceremony.
 *   - identity_assertion  — ID-JAG (verified synchronously) or, when paired with
 *                           assertion_type=verified_email, the OTP flow.
 *
 * IP rate limiting distinguishes the cheap/unverified flows (anonymous,
 * verified_email) from the verified identity_assertion path, which gets a higher
 * per-IP limit. The OTP/credential mechanics live in lib/agent/agent-auth.ts and
 * lib/agent/id-jag.ts; this route only validates input and dispatches.
 */

const ID_JAG_ASSERTION_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const VERIFIED_EMAIL_ASSERTION_TYPE = "verified_email";

/** Request body size cap (matches parseJsonBody usage below). */
const MAX_BODY_BYTES = 16 * 1024;

/** RFC 5321 maximum email length; guards the regex against ReDoS-style backtracking. */
const MAX_EMAIL_LENGTH = 254;

/** Loose RFC 5322-ish email check: a single @ with non-empty, dot-bearing host. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function optionalClientName(body: Record<string, unknown>): string | undefined {
  return isString(body.client_name) ? body.client_name : undefined;
}

export async function POST(request: Request) {
  // The ID-JAG flow may arrive either as the RFC-style raw assertion (the JWT
  // IS the body, with Content-Type: application/jwt) or JSON-wrapped. Normalize
  // both to a single JSON-shaped `body`. Every other flow is JSON.
  let body: Record<string, unknown>;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/jwt")) {
    // Reject oversized bodies before reading, using the declared length when present.
    const contentLength = request.headers.get("content-length");
    if (contentLength) {
      const declared = parseInt(contentLength, 10);
      if (!isNaN(declared) && declared > MAX_BODY_BYTES) {
        return Response.json(
          { error: `Request body too large (max ${MAX_BODY_BYTES} bytes)` },
          { status: 413 }
        );
      }
    }
    // Bound the read even when Content-Length is absent or spoofed.
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return Response.json(
        { error: `Request body too large (max ${MAX_BODY_BYTES} bytes)` },
        { status: 413 }
      );
    }
    body = {
      type: "identity_assertion",
      assertion_type: ID_JAG_ASSERTION_TYPE,
      assertion: raw.trim(),
    };
  } else {
    const parsed = await parseJsonBody(request, MAX_BODY_BYTES);
    if ("error" in parsed) return parsed.error;
    body = parsed.data as Record<string, unknown>;
  }

  // The flow is selected by `type`; accept the `identity_type` alias too (the
  // auth.md spec uses that name in places). Either resolves to `flowType`.
  const flowType = isString(body.type)
    ? body.type
    : isString(body.identity_type)
      ? body.identity_type
      : undefined;

  // IP rate limit. identity_assertion is verified and gets a higher limit;
  // anonymous/verified_email share the lower registration limit. Same window.
  const isIdJagFlow =
    flowType === "identity_assertion" && body.assertion_type === ID_JAG_ASSERTION_TYPE;

  const rateLimit = await checkRateLimitWithInfo(
    request,
    isIdJagFlow ? serverEnv().AGENT_IDJAG_RATE_LIMIT : serverEnv().AGENT_REGISTER_RATE_LIMIT,
    serverEnv().AGENT_REGISTER_RATE_WINDOW_MS
  );
  if (rateLimit.response) {
    return rateLimit.response;
  }

  try {
    // Anonymous — immediate unowned credential.
    if (flowType === "anonymous") {
      if (body.requested_credential_type !== "api_key") {
        return Response.json({ error: "unsupported_credential_type" }, { status: 400 });
      }
      const result = await createAnonymousRegistration({
        clientName: optionalClientName(body),
      });
      return applyRateLimitHeaders(Response.json(result, { status: 200 }), rateLimit);
    }

    // Verified email (OTP). Either an explicit verified_email type, or an
    // identity_assertion whose assertion_type selects the email flow.
    const isVerifiedEmailFlow =
      flowType === "verified_email" ||
      (flowType === "identity_assertion" && body.assertion_type === VERIFIED_EMAIL_ASSERTION_TYPE);

    if (isVerifiedEmailFlow) {
      const emailValue = isString(body.assertion)
        ? body.assertion
        : isString(body.email)
          ? body.email
          : null;
      // Bound length before the regex so worst-case backtracking is capped (ReDoS guard).
      if (!emailValue || emailValue.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(emailValue)) {
        return Response.json({ error: "invalid_email" }, { status: 400 });
      }
      const claim = await issueVerifiedEmailClaim({
        email: emailValue,
        clientName: optionalClientName(body),
      });
      return applyRateLimitHeaders(
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
      );
    }

    // Identity assertion (ID-JAG). Verified synchronously via JWKS.
    if (isIdJagFlow) {
      if (!isString(body.assertion)) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const verified = await verifyIdJag(body.assertion);
      if (!verified.ok) {
        return Response.json({ error: verified.error }, { status: 400 });
      }
      const issued = await issueIdJagCredential(verified);
      if (!issued.ok) {
        return Response.json({ error: issued.error }, { status: 400 });
      }
      return applyRateLimitHeaders(
        Response.json(
          {
            credential: issued.value.credential,
            credential_type: issued.value.credential_type,
            credential_expires: issued.value.credential_expires,
            scopes: issued.value.scopes,
          },
          { status: 200 }
        ),
        rateLimit
      );
    }

    // Unknown / unsupported request shape.
    return Response.json({ error: "invalid_request" }, { status: 400 });
  } catch (err) {
    // Capacity/throttle limits surface as their own status + auth.md code.
    if (err instanceof AgentRequestError) {
      return applyRateLimitHeaders(
        Response.json({ error: err.code }, { status: err.status }),
        rateLimit
      );
    }
    sendError(err instanceof Error ? err : new Error(String(err)));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
