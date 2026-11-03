import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { endViewSession, getViewSession, viewEndpoints } from "@/lib/ops/view";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { isUuid } from "@/lib/uuid";

const GONE = () =>
  opsJson(
    { error: "This view has ended: it expired, or the user withdrew access.", code: "view_ended" },
    { status: 410 }
  );

/** The live view and the account's endpoints. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return GONE();
  try {
    const session = await getViewSession(auth.userId, id);
    if (!session) return GONE();
    return opsJson({ session, endpoints: await viewEndpoints(session) });
  } catch (error) {
    reportError("[ops] reading a view failed", error);
    return opsJson({ error: "The view could not be loaded." }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return new Response(null, { status: 204 });
  try {
    await endViewSession(auth.userId, id);
    await auditUserAction(request, auth.userId, {
      action: "ops.view_ended",
      status: 204,
      targetId: id,
    });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    reportError("[ops] ending a view failed", error);
    return opsJson({ error: "The view could not be ended." }, { status: 500 });
  }
}
