import { authenticateRequest } from "@/lib/api-auth";
import { leaveTeam } from "@/lib/supabase/teams";

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  try {
    const left = await leaveTeam(auth.userId, teamId);
    if (!left) {
      return Response.json(
        { error: "Cannot leave team (not a member, or you are the owner)" },
        { status: 400 }
      );
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error("Failed to leave team:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
