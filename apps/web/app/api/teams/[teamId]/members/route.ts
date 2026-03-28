import { authenticateRequest } from "@/lib/api-auth";
import { listTeamMembers, listPendingInvitesForTeam } from "@/lib/supabase/teams";

export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  try {
    const [members, invites] = await Promise.all([
      listTeamMembers(auth.userId, teamId),
      listPendingInvitesForTeam(auth.userId, teamId),
    ]);

    if (members === null) {
      return Response.json({ error: "Team not found" }, { status: 404 });
    }

    return Response.json({ members, pendingInvites: invites ?? [] });
  } catch (error) {
    console.error("Failed to list team members:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
