import { authenticateSessionRequest } from "@/lib/api-auth";
import { handleCapacityGet, handleCapacityPost } from "@/lib/capacity-route";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): Response {
  return Response.json({ error: "Team not found" }, { status: 404 });
}

/**
 * A team pool's extra request capacity (lib/capacity-route.ts). Members may
 * look; only the owner may change it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;
  if (!UUID.test(teamId)) return notFound();
  const { data: membership, error } = await createAdminClient()
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (error) {
    return Response.json({ error: "Could not read the team" }, { status: 500 });
  }
  if (!membership) return notFound();

  return handleCapacityGet({ kind: "team", teamId });
}

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;
  if (!UUID.test(teamId)) return notFound();
  return handleCapacityPost(request, { kind: "team", teamId }, auth.userId);
}
