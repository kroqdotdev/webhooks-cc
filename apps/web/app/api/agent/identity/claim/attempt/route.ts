import { sendError } from "@appsignal/nodejs";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { accountEmail, readClaimAttempt } from "@/lib/agent/claims";
import { agentError, rateLimitedResponse } from "@/lib/agent/errors";

/**
 * GET /api/agent/identity/claim/attempt?attempt=<cat_...>: what the claim
 * page shows a signed-in human about the agent asking to connect. Session
 * only; API keys and agent tokens are refused.
 */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const limit = await checkRateLimitByKeyWithInfo(`agent-claim-read:${auth.userId}`, 60, 60_000);
  if (limit.response) return rateLimitedResponse(limit.response);

  const attempt = new URL(request.url).searchParams.get("attempt") ?? "";
  try {
    const view = await readClaimAttempt(attempt, {
      id: auth.userId,
      email: await accountEmail(auth.userId),
    });
    if (!view) {
      return agentError(
        404,
        "not_found",
        "This link is unknown, used, or replaced by a newer one."
      );
    }
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not read the request.");
  }
}
