import { sendError } from "@appsignal/nodejs";
import { checkRateLimitWithInfo } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { ASSERTION_REVOKED_EVENT } from "@/lib/agent/constants";
import { readBoundedBody } from "@/lib/agent/http";
import {
  recordJti,
  securityEventSeen,
  verifySecurityEvent,
  type IdJagError,
} from "@/lib/agent/id-jag";

/**
 * POST /api/agent/event/notify: the Security Event Token receiver (RFC 8935
 * push delivery, auth.md events_endpoint). A trusted ID-JAG provider posts a
 * signed SET (`application/secevent+jwt`); for the assertion-revoked event,
 * every registration of that provider identity is revoked with its tokens
 * (the delegation goes too, so the next ID-JAG starts over). Unknown events
 * are ignored (RFC 8417 2.2).
 *
 * 202 with no body once the events are processed, and for a SET processed
 * before, so a provider retrying after a lost answer is not told it failed.
 * Revocation is idempotent, so the jti is recorded only after it succeeded:
 * a duplicate that arrives while the first delivery is still running, or
 * after it failed, is processed again rather than acknowledged unseen.
 * Errors are RFC 8935 2.4's `{ err, description }`.
 */

const MAX_SET_BYTES = 16 * 1024;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function setError(status: number, err: string, description: string): Response {
  return Response.json({ err, description }, { status, headers: { "Cache-Control": "no-store" } });
}

const VERIFY_ERRORS: Partial<Record<IdJagError, [string, string]>> = {
  invalid_issuer: ["invalid_issuer", "The issuer is not trusted here."],
  invalid_audience: ["invalid_audience", "The SET is not addressed to this service."],
  invalid_signature: ["invalid_key", "The SET signature could not be verified."],
  credential_expired: ["invalid_request", "The SET is missing iat, too old, or expired."],
};

export async function POST(request: Request) {
  const limit = await checkRateLimitWithInfo(
    request,
    "agent-event-notify",
    RATE_LIMIT,
    RATE_WINDOW_MS
  );
  if (limit.response) return limit.response;

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  if (contentType.toLowerCase() !== "application/secevent+jwt") {
    return setError(400, "invalid_request", "Send the SET as application/secevent+jwt.");
  }
  const body = await readBoundedBody(request, MAX_SET_BYTES);
  if (!body) {
    return setError(400, "invalid_request", "The SET is too large.");
  }
  const jwt = new TextDecoder().decode(body).trim();
  if (!jwt) {
    return setError(400, "invalid_request", "Send one SET as the request body.");
  }

  try {
    const verified = await verifySecurityEvent(jwt);
    if (!verified.ok) {
      const [err, description] = VERIFY_ERRORS[verified.error] ?? [
        "invalid_request",
        "The SET is malformed.",
      ];
      return setError(400, err, description);
    }

    if (await securityEventSeen(verified.jti, verified.iss)) {
      return new Response(null, { status: 202 });
    }

    if (Object.hasOwn(verified.events, ASSERTION_REVOKED_EVENT)) {
      const { error } = await createAdminClient().rpc("revoke_agent_delegation", {
        p_iss: verified.iss,
        p_sub: verified.sub,
      });
      if (error) throw error;
    }
    // From here on a replay is acknowledged without being processed again.
    // False means a concurrent duplicate recorded it first, which is fine.
    await recordJti(verified.jti, verified.iss, "set", verified.retainUntil);
    return new Response(null, { status: 202 });
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return setError(500, "temporarily_unavailable", "The SET could not be processed. Retry later.");
  }
}
