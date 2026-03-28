import { authenticateRequest } from "@/lib/api-auth";
import { updateTeam, deleteTeam } from "@/lib/supabase/teams";

export async function PATCH(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > 100) {
    return Response.json({ error: "Name must be between 1 and 100 characters" }, { status: 400 });
  }

  try {
    const updated = await updateTeam(auth.userId, teamId, name);
    if (!updated) {
      return Response.json({ error: "Team not found or not owner" }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error("Failed to update team:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> }
) {
  const auth = await authenticateRequest(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  try {
    const deleted = await deleteTeam(auth.userId, teamId);
    if (!deleted) {
      return Response.json({ error: "Team not found or not owner" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Failed to delete team:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
