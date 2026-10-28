import { checkRateLimitWithInfo } from "@/lib/rate-limit";
import { auditAgentEvent } from "@/lib/audit";
import { NO_STORE_HEADERS, oauthError } from "@/lib/agent/errors";
import { readAgentBody } from "@/lib/agent/http";
import { registerClient } from "@/lib/oauth/clients";
import { preflight, withCors } from "@/lib/oauth/cors";
import { reportError } from "@/lib/observability";

/**
 * POST /api/oauth2/register: Dynamic Client Registration (RFC 7591) for
 * MCP clients that do not use a Client ID Metadata Document yet. Open, as
 * the protocol needs, so it is rate limited per address, and a client nobody
 * uses is deleted again (cleanup_oauth()). Every client is registered as a
 * public client that proves itself with PKCE.
 */
export async function POST(request: Request) {
  const limit = await checkRateLimitWithInfo(request, "oauth-register", 20, 3_600_000);
  if (limit.response) {
    return withCors(
      oauthError(429, "rate_limited", "Too many registrations. Wait and retry.", {
        "Retry-After": limit.response.headers.get("Retry-After") ?? "3600",
      })
    );
  }

  const body = await readAgentBody(request);
  if (!body) {
    return withCors(
      oauthError(400, "invalid_client_metadata", "Send the client metadata as a JSON object.")
    );
  }

  try {
    const result = await registerClient(body);
    if ("error" in result) {
      return withCors(oauthError(400, result.error, result.description));
    }
    await auditAgentEvent(request, {
      action: "agent.oauth.client_registered",
      status: 201,
      targetId: result.client_id,
      metadata: { client_name: result.client_name ?? null },
    });
    return withCors(Response.json(result, { status: 201, headers: NO_STORE_HEADERS }));
  } catch (error) {
    reportError("POST /api/oauth2/register failed", error);
    return withCors(oauthError(500, "server_error", "Registration failed. Retry later."));
  }
}

export function OPTIONS() {
  return preflight();
}
