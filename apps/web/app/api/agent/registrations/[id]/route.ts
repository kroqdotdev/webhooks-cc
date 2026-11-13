import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { auditAgentEvent } from "@/lib/audit";
import { revokeConnectedAgent } from "@/lib/agent/claims";
import { reportError } from "@/lib/observability";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/agent/registrations/{id}: disconnects an agent. Its tokens stop
 * working at once and its assertion can mint no more; endpoints it brought
 * stay in the account. Any key of the account may do it, since it only takes
 * access away (an agent can disconnect itself, or another).
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404 });

  try {
    const revoked = await revokeConnectedAgent(auth.userId, id);
    await auditAgentEvent(request, {
      action: "agent.registration.revoked",
      status: revoked ? 204 : 404,
      actorUserId: auth.userId,
      targetId: id,
    });
    return revoked
      ? new Response(null, { status: 204 })
      : Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    reportError("DELETE /api/agent/registrations/[id] failed", error);
    return Response.json({ error: "Failed to disconnect the agent" }, { status: 500 });
  }
}
