import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { startViewSession, ViewError } from "@/lib/ops/view";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { ticketRowByNumber } from "@/lib/support/tickets";

/** Opens a 30-minute read-only view of the account behind a ticket with access. */
export async function POST(request: Request) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return opsJson({ error: "Invalid JSON." }, { status: 400 });
  }
  const number = typeof body.ticketNumber === "number" ? body.ticketNumber : NaN;
  if (!Number.isInteger(number)) return opsJson({ error: "Name the ticket." }, { status: 400 });
  try {
    const ticket = await ticketRowByNumber(number);
    if (!ticket) return opsJson({ error: "No such ticket." }, { status: 404 });
    const session = await startViewSession(auth.userId, ticket.id);
    await auditUserAction(request, auth.userId, {
      action: "ops.view_started",
      status: 201,
      targetId: session.id,
      targetUserId: session.userId,
      metadata: { ticket: number },
    });
    return opsJson(session, { status: 201 });
  } catch (error) {
    if (error instanceof ViewError)
      return opsJson({ error: error.message }, { status: error.status });
    reportError("[ops] starting a view failed", error);
    return opsJson({ error: "The view could not be opened." }, { status: 500 });
  }
}
