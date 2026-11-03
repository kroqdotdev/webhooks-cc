import { reportError } from "@/lib/observability";
import { getViewSession, viewRequest, ViewError } from "@/lib/ops/view";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { isUuid } from "@/lib/uuid";

/** One request's contents, inside a live view. Logged for the user. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> }
) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id, requestId } = await params;
  if (!isUuid(id) || !isUuid(requestId)) return opsJson({ error: "Not found" }, { status: 404 });
  try {
    const session = await getViewSession(auth.userId, id);
    if (!session)
      return opsJson({ error: "This view has ended.", code: "view_ended" }, { status: 410 });
    return opsJson(await viewRequest(auth.userId, session, requestId));
  } catch (error) {
    if (error instanceof ViewError)
      return opsJson({ error: error.message }, { status: error.status });
    reportError("[ops] reading a request in a view failed", error);
    return opsJson({ error: "The request could not be loaded." }, { status: 500 });
  }
}
