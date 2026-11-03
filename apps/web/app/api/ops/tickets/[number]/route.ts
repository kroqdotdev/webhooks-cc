import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { staffTicket } from "@/lib/ops/tickets";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { closeTicket, ticketRowByNumber, updateTicket } from "@/lib/support/tickets";

function parseNumber(raw: string): number | null {
  return /^\d{1,12}$/.test(raw) ? Number(raw) : null;
}

export async function GET(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const number = parseNumber((await params).number);
  if (number === null) return opsJson({ error: "No such ticket." }, { status: 404 });
  try {
    const row = await ticketRowByNumber(number);
    if (!row) return opsJson({ error: "No such ticket." }, { status: 404 });
    return opsJson(await staffTicket(row));
  } catch (error) {
    reportError("[ops] reading a ticket failed", error);
    return opsJson({ error: "The ticket could not be loaded." }, { status: 500 });
  }
}

/** Snooze (until a time, or null to wake), mark spam, close. */
export async function PATCH(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const number = parseNumber((await params).number);
  if (number === null) return opsJson({ error: "No such ticket." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return opsJson({ error: "Invalid JSON." }, { status: 400 });
  }
  try {
    const row = await ticketRowByNumber(number);
    if (!row) return opsJson({ error: "No such ticket." }, { status: 404 });
    const changes: Record<string, unknown> = {};
    if ("snoozeUntil" in body) {
      const until = body.snoozeUntil;
      if (until !== null && (typeof until !== "string" || Number.isNaN(Date.parse(until)))) {
        return opsJson({ error: "Snooze needs a time." }, { status: 400 });
      }
      await updateTicket(row.id, { snoozed_until: until as string | null });
      changes.snoozeUntil = until;
    }
    if (typeof body.spam === "boolean") {
      await updateTicket(row.id, { spam: body.spam });
      changes.spam = body.spam;
    }
    if (body.close === true && row.status === "open") {
      await closeTicket(row.id, "staff", auth.userId);
      changes.closed = true;
    }
    await auditUserAction(request, auth.userId, {
      action: "ops.ticket_updated",
      status: 200,
      targetId: row.id,
      targetUserId: row.user_id,
      metadata: changes,
    });
    const fresh = await ticketRowByNumber(number);
    return opsJson(fresh ? await staffTicket(fresh) : null);
  } catch (error) {
    reportError("[ops] updating a ticket failed", error);
    return opsJson({ error: "The change could not be saved." }, { status: 500 });
  }
}
