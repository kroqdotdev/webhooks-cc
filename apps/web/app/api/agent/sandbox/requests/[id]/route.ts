import { sendError } from "@appsignal/nodejs";
import { agentError } from "@/lib/agent/errors";
import { authenticateSandbox } from "@/lib/agent/sandbox";
import { getSandboxRequest } from "@/lib/supabase/requests";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One captured request, when one of the bearer's sandbox endpoints captured it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authed = await authenticateSandbox(request, { read: true });
  if (!authed.ok) return authed.response;
  const { id } = await params;

  const notFound = () =>
    agentError(404, "not_found", "No such request in this registration's sandbox.");
  if (!UUID.test(id)) return notFound();

  try {
    const captured = await getSandboxRequest(authed.registration.id, id);
    return captured ? Response.json(captured) : notFound();
  } catch (error) {
    sendError(error instanceof Error ? error : new Error(String(error)));
    return agentError(500, "server_error", "Could not read the request.");
  }
}
