import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { acceptInvite } from "@/lib/supabase/teams";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ inviteId: string }> }
) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { inviteId } = await params;

  try {
    const result = await acceptInvite(auth.userId, inviteId);
    if (!result.accepted) {
      if (result.error) {
        return Response.json({ error: result.error }, { status: 400 });
      }
      return Response.json({ error: "Invite not found" }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error("Failed to accept invite:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
