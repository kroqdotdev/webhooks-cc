import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { declineInvite } from "@/lib/supabase/teams";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ inviteId: string }> }
) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { inviteId } = await params;

  try {
    const declined = await declineInvite(auth.userId, inviteId);
    if (!declined) {
      return Response.json({ error: "Invite not found" }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error("Failed to decline invite:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
