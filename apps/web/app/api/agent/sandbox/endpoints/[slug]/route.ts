import { sendError } from "@appsignal/nodejs";
import { auditAgentEvent } from "@/lib/audit";
import { agentError } from "@/lib/agent/errors";
import { invalidatePoolUsage } from "@/lib/agent/registrations";
import { authenticateSandbox, sandboxEndpointJson, sandboxNotFound } from "@/lib/agent/sandbox";
import { deleteSandboxEndpointBySlug, getSandboxEndpointBySlug } from "@/lib/supabase/endpoints";

/**
 * One sandbox endpoint of the bearer's registration. A slug of another
 * registration, or of any account, answers the same 404 as a missing one.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const authed = await authenticateSandbox(request, { read: true });
  if (!authed.ok) return authed.response;
  const { slug } = await params;

  try {
    const endpoint = await getSandboxEndpointBySlug(authed.registration.id, slug);
    if (!endpoint) return sandboxNotFound();
    return Response.json(sandboxEndpointJson(endpoint, authed.registration));
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not read the sandbox endpoint.");
  }
}

/**
 * Deletes the endpoint and its captures, freeing a slot in the pool. The
 * registration's request budget is not refunded.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const authed = await authenticateSandbox(request);
  if (!authed.ok) return authed.response;
  const { slug } = await params;

  try {
    const deletedId = await deleteSandboxEndpointBySlug(authed.registration.id, slug);
    if (!deletedId) return sandboxNotFound();
    invalidatePoolUsage();
    await auditAgentEvent(request, {
      action: "agent.sandbox.endpoint_deleted",
      status: 204,
      targetId: authed.registration.id,
      metadata: { endpoint_id: deletedId },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not delete the sandbox endpoint.");
  }
}
