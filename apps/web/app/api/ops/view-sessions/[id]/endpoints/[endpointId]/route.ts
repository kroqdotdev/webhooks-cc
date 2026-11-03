import { reportError } from "@/lib/observability";
import { getViewSession, viewRequests, ViewError } from "@/lib/ops/view";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { isUuid } from "@/lib/uuid";

/** The endpoint's latest 50 requests, inside a live view. Logged for the user. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; endpointId: string }> }
) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const { id, endpointId } = await params;
  if (!isUuid(id) || !isUuid(endpointId)) return opsJson({ error: "Not found" }, { status: 404 });
  try {
    const session = await getViewSession(auth.userId, id);
    if (!session)
      return opsJson({ error: "This view has ended.", code: "view_ended" }, { status: 410 });
    return opsJson(await viewRequests(auth.userId, session, endpointId));
  } catch (error) {
    if (error instanceof ViewError)
      return opsJson({ error: error.message }, { status: error.status });
    reportError("[ops] reading requests in a view failed", error);
    return opsJson({ error: "The requests could not be loaded." }, { status: 500 });
  }
}
