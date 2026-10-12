import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { listTeamMembers, listPendingInvitesForTeam } from "@/lib/supabase/teams";
import { reportError } from "@/lib/observability";

export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
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
    reportError("Failed to list team members", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
