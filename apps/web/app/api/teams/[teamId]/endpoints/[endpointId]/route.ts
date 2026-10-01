import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { unshareEndpointFromTeam } from "@/lib/supabase/teams";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string; endpointId: string }> }
) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { teamId, endpointId } = await params;

  try {
    const removed = await unshareEndpointFromTeam(auth.userId, teamId, endpointId);
    await auditUserAction(request, auth.userId, {
      action: "team.endpoint_unshared",
      status: removed ? 204 : 404,
      teamId,
      targetId: endpointId,
    });
    if (!removed) {
      return Response.json({ error: "Not found or not authorized" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to unshare endpoint:", error);
    await auditUserAction(request, auth.userId, {
      action: "team.endpoint_unshared",
      status: 500,
      teamId,
      targetId: endpointId,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
