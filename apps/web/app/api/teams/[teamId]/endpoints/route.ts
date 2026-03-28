import { authenticateRequest } from "@/lib/api-auth";
import { shareEndpointWithTeam } from "@/lib/supabase/teams";

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const endpointId = typeof body.endpointId === "string" ? body.endpointId : "";
  if (!endpointId) {
    return Response.json({ error: "endpointId is required" }, { status: 400 });
  }

  try {
    const result = await shareEndpointWithTeam(auth.userId, teamId, endpointId);
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error("Failed to share endpoint:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
