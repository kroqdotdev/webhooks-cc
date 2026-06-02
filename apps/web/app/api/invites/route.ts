import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { listPendingInvitesForUser } from "@/lib/supabase/teams";

export async function GET(request: Request) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  try {
    const invites = await listPendingInvitesForUser(auth.userId);
    return Response.json(invites);
  } catch (error) {
    console.error("Failed to list invites:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
