import { authenticateRequest } from "@/lib/api-auth";
import { unshareEndpointFromTeam } from "@/lib/supabase/teams";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string; endpointId: string }> }
) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { teamId, endpointId } = await params;

  try {
    const removed = await unshareEndpointFromTeam(auth.userId, teamId, endpointId);
    if (!removed) {
      return Response.json({ error: "Not found or not authorized" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to unshare endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
