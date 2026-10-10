import { sendError } from "@appsignal/nodejs";
import { SANDBOX_MAX_LIST } from "@/lib/agent/constants";
import { agentError } from "@/lib/agent/errors";
import { authenticateSandbox, sandboxNotFound } from "@/lib/agent/sandbox";
import { getSandboxEndpointBySlug } from "@/lib/supabase/endpoints";
import { listRequestsForSandboxEndpoint } from "@/lib/supabase/requests";

/**
 * Requests a sandbox endpoint captured, newest first: `?since=<ms>` keeps
 * those received at or after it, `?limit=` caps the list (at most 100). The
 * same shape as GET /api/endpoints/{slug}/requests.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const authed = await authenticateSandbox(request, { read: true });
  if (!authed.ok) return authed.response;
  const { slug } = await params;

  const url = new URL(request.url);
  const limit = url.searchParams.get("limit");
  const since = url.searchParams.get("since");
  const parsedLimit = limit === null ? undefined : Number(limit);
  const parsedSince = since === null ? undefined : Number(since);
  if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
    return agentError(400, "invalid_request", "limit must be a positive number.");
  }
  if (parsedSince !== undefined && (!Number.isFinite(parsedSince) || parsedSince < 0)) {
    return agentError(400, "invalid_request", "since must be a timestamp in milliseconds.");
  }

  try {
    const endpoint = await getSandboxEndpointBySlug(authed.registration.id, slug);
    if (!endpoint) return sandboxNotFound();
    const requests = await listRequestsForSandboxEndpoint(endpoint.id, {
      since: parsedSince,
      limit: parsedLimit,
      maxLimit: SANDBOX_MAX_LIST,
    });
    return Response.json(requests);
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not list the sandbox requests.");
  }
}
