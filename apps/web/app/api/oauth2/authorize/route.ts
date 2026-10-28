import { authenticateSessionRequest } from "@/lib/api-auth";
import { auditAgentEvent } from "@/lib/audit";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { MAX_CONNECTED_AGENTS } from "@/lib/agent/constants";
import { accountEmail } from "@/lib/agent/claims";
import { agentError, rateLimitedResponse } from "@/lib/agent/errors";
import { readAgentBody } from "@/lib/agent/http";
import {
  approveAuthorization,
  checkAuthorizationRequest,
  denyAuthorization,
} from "@/lib/oauth/authorize";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";

/**
 * The consent page's backend (/oauth/authorize). Session only, with the
 * session's access token as the bearer (never a cookie), so another site
 * cannot approve anything on the human's behalf; API keys and agent tokens
 * are refused.
 *
 * GET ?<authorization request>: what the page shows, or why it cannot go on
 *   (shown to the human, never redirected).
 * POST { ...authorization request, decision: "approve" | "deny" }: where to
 *   send the human next, `{ redirect }`. The page navigates there itself, so
 *   the form-action CSP never stands between it and the client's redirect URI.
 */

const PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const;

async function connectedAgents(userId: string): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("agent_registrations")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .not("claimed_at", "is", null)
    .is("revoked_at", null);
  if (error) throw error;
  return count ?? 0;
}

export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const limit = await checkRateLimitByKeyWithInfo(`oauth-authorize:${auth.userId}`, 60, 60_000);
  if (limit.response) return rateLimitedResponse(limit.response);

  try {
    const check = await checkAuthorizationRequest(new URL(request.url).searchParams);
    if (!check.ok) return agentError(400, check.error, check.description);
    const connected = await connectedAgents(auth.userId);
    return Response.json(
      {
        client: {
          name: check.client.name,
          verifiedHost: check.client.verifiedHost,
          clientUri: check.client.clientUri,
          kind: check.client.kind,
        },
        redirectHost: new URL(check.request.redirectUri).host || check.request.redirectUri,
        scope: check.request.scope,
        signedInAs: await accountEmail(auth.userId),
        connectedAgents: connected,
        maxAgents: MAX_CONNECTED_AGENTS,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    reportError("GET /api/oauth2/authorize failed", error);
    return agentError(500, "server_error", "Could not read the request.");
  }
}

export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const limit = await checkRateLimitByKeyWithInfo(`oauth-authorize:${auth.userId}`, 60, 60_000);
  if (limit.response) return rateLimitedResponse(limit.response);

  const body = await readAgentBody(request);
  if (!body || (body.decision !== "approve" && body.decision !== "deny")) {
    return agentError(400, "invalid_request", "Send the request and a decision.");
  }
  const params = new URLSearchParams();
  for (const name of PARAMS) {
    const value = body[name];
    if (typeof value === "string") params.set(name, value);
  }

  try {
    // Checked again: the page's copy of the request is not trusted.
    const check = await checkAuthorizationRequest(params);
    if (!check.ok) return agentError(400, check.error, check.description);

    if (body.decision === "deny") {
      await auditAgentEvent(request, {
        action: "agent.oauth.denied",
        status: 200,
        actorUserId: auth.userId,
        targetId: check.request.clientId,
        metadata: { client_name: check.client.name },
      });
      return Response.json(
        { redirect: denyAuthorization(check.request) },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    if ((await connectedAgents(auth.userId)) >= MAX_CONNECTED_AGENTS) {
      return agentError(
        409,
        "too_many_agents",
        `An account connects at most ${MAX_CONNECTED_AGENTS} agents. Disconnect one under Connected agents first.`
      );
    }
    const redirect = await approveAuthorization(check.request, check.client, auth.userId);
    await auditAgentEvent(request, {
      action: "agent.oauth.approved",
      status: 200,
      actorUserId: auth.userId,
      targetUserId: auth.userId,
      targetId: check.request.clientId,
      metadata: {
        client_name: check.client.name,
        client_kind: check.client.kind,
        verified_host: check.client.verifiedHost,
      },
    });
    return Response.json({ redirect }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    reportError("POST /api/oauth2/authorize failed", error);
    return agentError(500, "server_error", "Could not complete the request.");
  }
}
