import { reportError } from "@/lib/observability";
import { isQueueView, listQueue } from "@/lib/ops/tickets";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";

/** One view of the inbox: waiting, user, snoozed, closed or spam. */
export async function GET(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const view = new URL(request.url).searchParams.get("view") ?? "waiting";
  if (!isQueueView(view)) return opsJson({ error: "Unknown view." }, { status: 400 });
  try {
    return opsJson({ view, tickets: await listQueue(view) });
  } catch (error) {
    reportError("[ops] listing tickets failed", error);
    return opsJson({ error: "The tickets could not be loaded." }, { status: 500 });
  }
}
