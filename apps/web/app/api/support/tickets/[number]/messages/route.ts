import { authenticateSessionRequest } from "@/lib/api-auth";
import { auditUserAction } from "@/lib/audit";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import { readSupportForm, textField } from "@/lib/support/form";
import { BODY_MAX } from "@/lib/support/shared";
import {
  attachmentsEnabled,
  postMessage,
  storeAttachments,
  SupportError,
  ticketDetail,
  userTicketRow,
} from "@/lib/support/tickets";

/** The user replies on their ticket (a reply reopens a recently closed one). */
export async function POST(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  const raw = (await params).number;
  if (!/^\d{1,12}$/.test(raw)) return Response.json({ error: "No such ticket." }, { status: 404 });

  const limited = await checkRateLimitByKey(`support:reply:${auth.userId}`, 30, 60 * 60_000);
  if (limited) return limited;

  const form = await readSupportForm(request, attachmentsEnabled());
  if (!form.ok) return form.response;
  const body = textField(form.value.fields.body);
  if (!body && form.value.images.length === 0) {
    return Response.json({ error: "Write a reply first." }, { status: 400 });
  }
  if (body.length > BODY_MAX) {
    return Response.json(
      { error: `Replies can be at most ${BODY_MAX.toLocaleString("en-US")} characters.` },
      { status: 400 }
    );
  }

  try {
    const row = await userTicketRow(auth.userId, Number(raw));
    if (!row) return Response.json({ error: "No such ticket." }, { status: 404 });
    const { messageId } = await postMessage({
      ticketId: row.id,
      author: "user",
      authorId: auth.userId,
      kind: "message",
      body,
    });
    const stored = messageId ? await storeAttachments(row.id, messageId, form.value.images) : 0;
    await auditUserAction(request, auth.userId, {
      action: "support.reply_posted",
      status: 201,
      targetId: row.id,
      metadata: { images: stored },
    });
    const fresh = await userTicketRow(auth.userId, Number(raw));
    return Response.json(
      {
        ticket: fresh ? await ticketDetail(fresh, "user") : null,
        imagesFailed: form.value.images.length - stored,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SupportError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    reportError("[support] posting a reply failed", error);
    return Response.json({ error: "The reply could not be sent. Try again." }, { status: 500 });
  }
}
