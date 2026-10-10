import { sendError } from "@appsignal/nodejs";
import { checkRateLimitWithInfo } from "@/lib/rate-limit";
import { agentError, agentErrorResponse, rateLimitedResponse } from "@/lib/agent/errors";
import { anonymousRegistrationUnavailable, newRegistrationChallenge } from "@/lib/agent/http";

/**
 * POST /api/agent/identity/challenge: a proof-of-work challenge for anonymous
 * registration (our extension to auth.md, advertised under
 * agent_auth.anonymous.proof_of_work). No body, no credentials.
 */
export async function POST(request: Request) {
  const limit = await checkRateLimitWithInfo(request, "agent-challenge", 30, 60_000);
  if (limit.response) return rateLimitedResponse(limit.response);

  try {
    const unavailable = await anonymousRegistrationUnavailable();
    if (unavailable) return agentErrorResponse(unavailable);
    return Response.json(await newRegistrationChallenge(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not issue a challenge. Retry later.");
  }
}
