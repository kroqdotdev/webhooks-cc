import { authenticateRequest } from "@/lib/api-auth";
import type { Database } from "@/lib/supabase/database";
import type { SandboxEndpointRecord } from "@/lib/supabase/endpoints";
import { checkRateLimitByKeyWithInfo } from "@/lib/rate-limit";
import { SANDBOX_MAX_ENDPOINTS, SANDBOX_REQUESTS_PER_ENDPOINT } from "./constants";
import { agentError, rateLimitedResponse } from "./errors";
import { sandboxRegistration } from "./registrations";

/**
 * The agent sandbox (auth.md v0.6): what an anonymous registration's
 * pre-claim access token can do. Every read and write is scoped by the
 * registration id from the bearer's api_keys row, server-side.
 */

type RegistrationRow = Database["public"]["Tables"]["agent_registrations"]["Row"];

const READS_PER_MINUTE = 120;

export type SandboxAuth =
  { ok: true; registration: RegistrationRow } | { ok: false; response: Response };

export async function authenticateSandbox(
  request: Request,
  options: { read?: boolean } = {}
): Promise<SandboxAuth> {
  const auth = await authenticateRequest(request);
  if (!auth.success) return { ok: false, response: auth.response };

  const access = await sandboxRegistration(auth);
  if (!access.ok) {
    return {
      ok: false,
      response:
        access.reason === "not_sandbox"
          ? agentError(
              403,
              "sandbox_only",
              "The sandbox takes access tokens of anonymous agent registrations. API keys use /api/endpoints."
            )
          : agentError(
              403,
              "sandbox_closed",
              "This registration was claimed, revoked or has expired. A claimed agent uses the normal API."
            ),
    };
  }

  if (options.read) {
    const limit = await checkRateLimitByKeyWithInfo(
      `sandbox-read:${access.registration.id}`,
      READS_PER_MINUTE,
      60_000
    );
    if (limit.response) return { ok: false, response: rateLimitedResponse(limit.response) };
  }
  return { ok: true, registration: access.registration };
}

/** The registration-wide limits, attached to every sandbox endpoint. */
export function sandboxLimits(registration: RegistrationRow) {
  return {
    expiresAt: Date.parse(registration.expires_at),
    maxEndpoints: SANDBOX_MAX_ENDPOINTS,
    requestLimit: SANDBOX_REQUESTS_PER_ENDPOINT,
    budget: {
      used: registration.sandbox_requests_used,
      limit: registration.sandbox_request_limit,
    },
  };
}

export function sandboxEndpointJson(
  endpoint: SandboxEndpointRecord,
  registration: RegistrationRow
) {
  return { ...endpoint, sandbox: sandboxLimits(registration) };
}

export function sandboxNotFound(): Response {
  return agentError(404, "not_found", "No such sandbox endpoint for this registration.");
}
