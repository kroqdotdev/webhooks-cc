import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { staffTicket } from "@/lib/ops/tickets";
import { authenticateStaffRequest, opsJson } from "@/lib/staff";
import { boolField, readSupportForm, textField } from "@/lib/support/form";
import { BODY_MAX } from "@/lib/support/shared";
import {
  attachmentsEnabled,
  closeTicket,
  postMessage,
  storeAttachments,
  ticketRowByNumber,
} from "@/lib/support/tickets";

/** A staff reply (optionally closing the ticket) or an internal note. */
export async function POST(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await authenticateStaffRequest(request);
  if (!auth.success) return auth.response;
  const raw = (await params).number;
  if (!/^\d{1,12}$/.test(raw)) return opsJson({ error: "No such ticket." }, { status: 404 });

  const form = await readSupportForm(request, attachmentsEnabled());
  if (!form.ok) return form.response;
  const { fields, images } = form.value;
  const kind = fields.kind === "note" ? "note" : "message";
  const body = textField(fields.body);
  const close = kind === "message" && boolField(fields.close, false);
  if (!body && !close && images.length === 0) {
    return opsJson({ error: "Write something first." }, { status: 400 });
  }
  if (body.length > BODY_MAX) {
    return opsJson({ error: "That is too long." }, { status: 400 });
  }

  try {
    const row = await ticketRowByNumber(Number(raw));
    if (!row) return opsJson({ error: "No such ticket." }, { status: 404 });
    // Screenshots without text still need a message to hang on, so a close
    // with only screenshots posts them first and closes after.
    const imagesOnlyClose = close && !body && images.length > 0;
    const { messageId } = await postMessage({
      ticketId: row.id,
      author: "staff",
      authorId: auth.userId,
      kind,
      body,
      close: close && !imagesOnlyClose,
    });
    if (imagesOnlyClose) await closeTicket(row.id, "staff", auth.userId);
    const stored = messageId ? await storeAttachments(row.id, messageId, images) : 0;
    await auditUserAction(request, auth.userId, {
      action: kind === "note" ? "ops.note_added" : "ops.ticket_replied",
      status: 201,
      targetId: row.id,
      targetUserId: row.user_id,
      metadata: { close, images: stored },
    });
    const fresh = await ticketRowByNumber(Number(raw));
    return opsJson(fresh ? await staffTicket(fresh) : null, { status: 201 });
  } catch (error) {
    reportError("[ops] posting a reply failed", error);
    return opsJson({ error: "The reply could not be sent." }, { status: 500 });
  }
}
