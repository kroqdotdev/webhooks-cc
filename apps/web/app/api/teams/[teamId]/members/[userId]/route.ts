import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { removeTeamMember } from "@/lib/supabase/teams";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string; userId: string }> }
) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { teamId, userId } = await params;

  try {
    const removed = await removeTeamMember(auth.userId, teamId, userId);
    await auditUserAction(request, auth.userId, {
      action: "team.member_removed",
      status: removed ? 204 : 404,
      teamId,
      targetUserId: userId,
    });
    if (!removed) {
      return Response.json({ error: "Not found or not authorized" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to remove team member:", error);
    await auditUserAction(request, auth.userId, {
      action: "team.member_removed",
      status: 500,
      teamId,
      targetUserId: userId,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
