import { authenticateSessionRequest } from "@/lib/api-auth";
import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import { textField } from "@/lib/support/form";
import {
  closeTicket,
  setAccess,
  ticketDetail,
  updateTicket,
  userTicketRow,
} from "@/lib/support/tickets";
import { parseJsonBodyWith } from "@/lib/request-validation";
import { z } from "zod";

function ticketNumber(value: string): number | null {
  return /^\d{1,12}$/.test(value) ? Number(value) : null;
}

const ticketChanges = z.object({
  notifyEmail: z.unknown().optional(),
  accessGranted: z.unknown().optional(),
  close: z.unknown().optional(),
  rating: z.unknown().optional(),
  ratingComment: z.unknown().optional(),
});

const NOT_FOUND = () => Response.json({ error: "No such ticket." }, { status: 404 });

/** One of the user's tickets, without staff notes. */
export async function GET(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const number = ticketNumber((await params).number);
  if (number === null) return NOT_FOUND();
  try {
    const row = await userTicketRow(auth.userId, number);
    if (!row) return NOT_FOUND();
    return Response.json(await ticketDetail(row, "user"), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    reportError("[support] reading a ticket failed", error);
    return Response.json({ error: "The ticket could not be loaded." }, { status: 500 });
  }
}

/**
 * The user's choices on a ticket: email updates, support access, closing
 * it, and the rating after it closed.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const number = ticketNumber((await params).number);
  if (number === null) return NOT_FOUND();
  const limited = await checkRateLimitByKey(`support:patch:${auth.userId}`, 60, 60_000);
  if (limited) return limited;

  const parsed = await parseJsonBodyWith(request, ticketChanges, { message: "Invalid JSON." });
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;

  try {
    const row = await userTicketRow(auth.userId, number);
    if (!row) return NOT_FOUND();

    if (typeof body.notifyEmail === "boolean" && body.notifyEmail !== row.notify_email) {
      await updateTicket(row.id, { notify_email: body.notifyEmail });
      await auditUserAction(request, auth.userId, {
        action: "support.ticket_updated",
        status: 200,
        targetId: row.id,
        metadata: { notifyEmail: body.notifyEmail },
      });
    }

    if (typeof body.accessGranted === "boolean") {
      if (body.accessGranted && row.status === "closed") {
        return Response.json(
          { error: "Access can only be given on an open ticket." },
          { status: 409 }
        );
      }
      if (await setAccess(row.id, auth.userId, body.accessGranted)) {
        await auditUserAction(request, auth.userId, {
          action: "support.access_changed",
          status: 200,
          targetId: row.id,
          metadata: { granted: body.accessGranted },
        });
      }
    }

    if (body.close === true && row.status === "open") {
      await closeTicket(row.id, "user", auth.userId);
      await auditUserAction(request, auth.userId, {
        action: "support.ticket_closed",
        status: 200,
        targetId: row.id,
      });
    }

    if (body.rating !== undefined) {
      const rating = body.rating;
      if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        return Response.json({ error: "Rate from 1 to 5." }, { status: 400 });
      }
      if (row.status !== "closed") {
        return Response.json({ error: "Rate a ticket once it is closed." }, { status: 409 });
      }
      await updateTicket(row.id, {
        rating,
        rating_comment: textField(body.ratingComment).slice(0, 1000) || null,
        rated_at: new Date().toISOString(),
      });
    }

    const fresh = await userTicketRow(auth.userId, number);
    return Response.json(fresh ? await ticketDetail(fresh, "user") : null);
  } catch (error) {
    reportError("[support] updating a ticket failed", error);
    return Response.json({ error: "The change could not be saved." }, { status: 500 });
  }
}
