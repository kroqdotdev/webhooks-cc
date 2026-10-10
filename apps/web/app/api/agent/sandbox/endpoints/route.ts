import { sendError } from "@appsignal/nodejs";
import { serverEnv } from "@/lib/env";
import { applyRateLimitHeaders, checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { auditAgentEvent } from "@/lib/audit";
import { SANDBOX_MAX_ENDPOINTS } from "@/lib/agent/constants";
import { agentError, rateLimitedResponse } from "@/lib/agent/errors";
import { invalidatePoolUsage } from "@/lib/agent/registrations";
import { authenticateSandbox, sandboxEndpointJson, sandboxLimits } from "@/lib/agent/sandbox";
import { createSandboxEndpoint, listSandboxEndpoints } from "@/lib/supabase/endpoints";

/**
 * The agent sandbox (auth.md v0.6), for the access token of an anonymous
 * registration:
 *   GET  - this registration's live endpoints
 *   POST - a new endpoint: capture only (no mock responses, notifications,
 *          signing, forwarding or email), living as long as the registration
 *
 * Limits: 3 live endpoints per registration, 25 captures per endpoint, 100
 * per registration, and a pool shared by all registrations
 * (AGENT_SANDBOX_MAX_ENDPOINTS). Other registrations' endpoints and every
 * real account stay invisible: reads are scoped by the registration id from
 * the bearer's own api_keys row.
 */

const CREATES_PER_HOUR = 20;

export async function GET(request: Request) {
  const authed = await authenticateSandbox(request, { read: true });
  if (!authed.ok) return authed.response;

  try {
    const endpoints = await listSandboxEndpoints(authed.registration.id);
    return Response.json({
      endpoints: endpoints.map((endpoint) => sandboxEndpointJson(endpoint, authed.registration)),
      sandbox: sandboxLimits(authed.registration),
    });
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not list sandbox endpoints.");
  }
}

export async function POST(request: Request) {
  const authed = await authenticateSandbox(request);
  if (!authed.ok) return authed.response;
  const { registration } = authed;

  const rateLimit = await checkRateLimitByKeyWithInfo(
    `sandbox-create:${registration.id}`,
    CREATES_PER_HOUR,
    60 * 60 * 1000
  );
  if (rateLimit.response) return rateLimitedResponse(rateLimit.response);

  try {
    // Nothing in the body is used: a sandbox endpoint has no settings.
    const result = await createSandboxEndpoint(registration.id, {
      maxEndpoints: SANDBOX_MAX_ENDPOINTS,
      poolSize: serverEnv().AGENT_SANDBOX_MAX_ENDPOINTS,
    });

    if (result.status === "endpoint_limit") {
      return applyRateLimitHeaders(
        agentError(
          409,
          "sandbox_endpoint_limit",
          `A sandbox registration holds at most ${SANDBOX_MAX_ENDPOINTS} endpoints. Delete one, or ask a human to create an account at webhooks.cc.`
        ),
        rateLimit
      );
    }
    if (result.status === "pool_full") {
      await auditAgentEvent(request, {
        action: "agent.sandbox.full",
        status: 503,
        targetId: registration.id,
      });
      return applyRateLimitHeaders(
        agentError(
          503,
          "sandbox_full",
          "The sandbox is full. Ask a human to sign up at https://webhooks.cc, or retry later.",
          {},
          { "Retry-After": "600" }
        ),
        rateLimit
      );
    }
    if (result.status === "registration_inactive") {
      return agentError(
        403,
        "sandbox_closed",
        "This registration was claimed, revoked or has expired. A claimed agent uses the normal API."
      );
    }

    invalidatePoolUsage();
    await auditAgentEvent(request, {
      action: "agent.sandbox.endpoint_created",
      status: 201,
      targetId: registration.id,
      metadata: { endpoint_id: result.endpoint.id },
    });
    return applyRateLimitHeaders(
      Response.json(sandboxEndpointJson(result.endpoint, registration), { status: 201 }),
      rateLimit
    );
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return applyRateLimitHeaders(
      agentError(500, "server_error", "Could not create a sandbox endpoint."),
      rateLimit
    );
  }
}
