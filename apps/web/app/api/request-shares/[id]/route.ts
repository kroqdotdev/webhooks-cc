import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { deleteRequestShare } from "@/lib/supabase/request-shares";
import { isUuid } from "@/lib/uuid";

/** Revoke a share link: the page answers 404 from now on. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "not_found" }, { status: 404 });

  try {
    const deleted = await deleteRequestShare(auth.userId, id);
    await auditUserAction(request, auth.userId, {
      action: "request.share_revoked",
      status: deleted ? 200 : 404,
      targetId: id,
    });
    if (!deleted) return Response.json({ error: "not_found" }, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    reportError("Failed to revoke request share", error);
    await auditUserAction(request, auth.userId, {
      action: "request.share_revoked",
      status: 500,
      targetId: id,
    });
    return Response.json({ error: "Failed to revoke share link" }, { status: 500 });
  }
}
