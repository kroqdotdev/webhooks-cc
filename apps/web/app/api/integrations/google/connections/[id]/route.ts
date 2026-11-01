import { auditUserAction } from "@/lib/audit";
import { authenticateSessionRequest } from "@/lib/api-auth";
import { revokeToken } from "@/lib/integrations/google";
import { reportError } from "@/lib/observability";
import { deleteGoogleConnection } from "@/lib/supabase/google-connections";

/**
 * DELETE /api/integrations/google/connections/{id}: disconnects a Google
 * account and revokes its grant at Google. Sheets destinations that used it
 * fail until another account is chosen.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  try {
    const token = await deleteGoogleConnection(auth.userId, id);
    if (token === null) return Response.json({ error: "not_found" }, { status: 404 });
    await revokeToken(token);
    await auditUserAction(request, auth.userId, {
      action: "integration.google_disconnected",
      status: 200,
      metadata: { connectionId: id },
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    reportError("Failed to disconnect Google", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
