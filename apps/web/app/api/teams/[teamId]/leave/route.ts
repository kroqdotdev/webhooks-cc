import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { leaveTeam } from "@/lib/supabase/teams";

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  try {
    const left = await leaveTeam(auth.userId, teamId);
    await auditUserAction(request, auth.userId, {
      action: "team.member_left",
      status: left ? 200 : 400,
      teamId,
      targetUserId: auth.userId,
    });
    if (!left) {
      return Response.json(
        { error: "Cannot leave team (not a member, or you are the owner)" },
        { status: 400 }
      );
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error("Failed to leave team:", error);
    await auditUserAction(request, auth.userId, {
      action: "team.member_left",
      status: 500,
      teamId,
      targetUserId: auth.userId,
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
