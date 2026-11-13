import { auditUserAction } from "@/lib/audit";
import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { updateTeam, deleteTeam } from "@/lib/supabase/teams";
import { loggablePolarError } from "@/lib/polar";
import { reportError } from "@/lib/observability";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

const renameTeamBody = z.object({ name: z.unknown().optional() });

export async function PATCH(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  const parsed = await parseJsonBodyWith(request, renameTeamBody, { message: "Invalid JSON body" });
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > 100) {
    return Response.json({ error: "Name must be between 1 and 100 characters" }, { status: 400 });
  }

  try {
    const updated = await updateTeam(auth.userId, teamId, name);
    await auditUserAction(request, auth.userId, {
      action: "team.renamed",
      status: updated ? 200 : 404,
      teamId,
      metadata: { name },
    });
    if (!updated) {
      return Response.json({ error: "Team not found or not owner" }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error) {
    reportError("Failed to update team", error);
    await auditUserAction(request, auth.userId, { action: "team.renamed", status: 500, teamId });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> }
) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { teamId } = await params;

  try {
    const deleted = await deleteTeam(auth.userId, teamId);
    await auditUserAction(request, auth.userId, {
      action: "team.deleted",
      status: deleted ? 204 : 404,
      teamId,
    });
    if (!deleted) {
      return Response.json({ error: "Team not found or not owner" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    reportError("Failed to delete team", loggablePolarError(error));
    await auditUserAction(request, auth.userId, { action: "team.deleted", status: 500, teamId });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
