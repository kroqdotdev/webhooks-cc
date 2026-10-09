import { authenticateSessionRequest } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/request-validation";
import { claimAnonymousForUser, claimAnonymousByUserCode } from "@/lib/agent/agent-auth";
import { sendError } from "@appsignal/nodejs";
import { auditAgentEvent } from "@/lib/audit";

/**
 * In-app claim confirmation (auth.md). A logged-in browser (NOT the agent, NOT
 * email) binds an anonymous registration's unowned key to the current user —
 * mirroring the /cli/verify ceremony. Session-only: API keys are rejected.
 *
 * Two equivalent inputs are accepted (exactly one required):
 *   - `claim_token` — the one-time clm_ token from the claim link, or
 *   - `user_code`   — the short human-typed code (e.g. "ABCD-EFGH").
 */
const CLAIM_ERROR_STATUS: Record<string, number> = {
  claim_expired: 410,
  invalid_claim_token: 400,
  previously_claimed: 409,
  too_many_keys: 429,
};

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  // Throttle by IP — the user_code path matches among pending claims, so without
  // a limit a logged-in caller could online-guess short codes. Mirrors the
  // sibling claim/verify-otp routes (defense in depth; the code space + 15-min
  // TTL already make guessing impractical).
  const rateLimited = await checkRateLimit(request, "agent-claim-confirm", 10);
  if (rateLimited) return rateLimited;

  const parsed = await parseJsonBody(request, 1024);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data as Record<string, unknown>;

  const claimToken = typeof body.claim_token === "string" ? body.claim_token : undefined;
  const userCode = typeof body.user_code === "string" ? body.user_code : undefined;

  // Require exactly one of the two inputs.
  if ((!claimToken && !userCode) || (claimToken && userCode)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // authenticateSessionRequest's success branch guarantees a non-null userId
  // (SessionAuthResult), so no null-guard is needed here.
  try {
    const result = claimToken
      ? await claimAnonymousForUser(claimToken, auth.userId)
      : await claimAnonymousByUserCode(userCode!, auth.userId);

    const method = claimToken ? "claim_token" : "user_code";
    if (result.ok) {
      await auditAgentEvent(request, {
        action: "agent.claim.confirmed",
        status: 200,
        actorUserId: auth.userId,
        targetUserId: auth.userId,
        metadata: { flow: "anonymous", method, client_name: result.clientName },
      });
      return Response.json({ status: "claimed" });
    }

    await auditAgentEvent(request, {
      action: "agent.claim.refused",
      status: CLAIM_ERROR_STATUS[result.error] ?? 500,
      actorUserId: auth.userId,
      metadata: { flow: "anonymous", method, code: result.error },
    });

    switch (result.error) {
      case "claim_expired":
        return Response.json({ error: "claim_expired" }, { status: 410 });
      case "invalid_claim_token":
        return Response.json({ error: "invalid_claim_token" }, { status: 400 });
      case "previously_claimed":
        return Response.json({ error: "previously_claimed" }, { status: 409 });
      case "too_many_keys":
        return Response.json({ error: "too_many_keys" }, { status: 429 });
      default:
        // Exhaustive over ClaimAnonymousResult["error"]; guard any future
        // variant so the handler never falls through without a response.
        return Response.json({ error: "unknown_error" }, { status: 500 });
    }
  } catch (err) {
    sendError(err instanceof Error ? err : new Error(String(err)));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
