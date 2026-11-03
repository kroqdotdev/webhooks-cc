import { authenticateSessionRequest } from "@/lib/api-auth";
import { auditUserAction } from "@/lib/audit";
import { APP_VERSION } from "@/lib/changelog";
import { reportError } from "@/lib/observability";
import { checkRateLimitByKey } from "@/lib/rate-limit";
import { siteForHost } from "@/lib/site";
import { boolField, readSupportForm, textField } from "@/lib/support/form";
import { BODY_MAX, isSupportCategory, SUBJECT_MAX } from "@/lib/support/shared";
import {
  attachmentsEnabled,
  createTicket,
  listUserTickets,
  storeAttachments,
  userEndpointChoices,
} from "@/lib/support/tickets";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";

/** The signed-in user's tickets, the endpoints a ticket can name, and whether images work. */
export async function GET(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;
  try {
    const [tickets, endpoints] = await Promise.all([
      listUserTickets(auth.userId),
      userEndpointChoices(auth.userId),
    ]);
    return Response.json(
      { tickets, endpoints, attachments: attachmentsEnabled() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    reportError("[support] listing tickets failed", error);
    return Response.json({ error: "Your tickets could not be loaded." }, { status: 500 });
  }
}

/** Opens a ticket: JSON, or multipart with screenshots under "images". */
export async function POST(request: Request) {
  const auth = await authenticateSessionRequest(request);
  if (!auth.success) return auth.response;

  const limited =
    (await checkRateLimitByKey(`support:new:${auth.userId}`, 3, 10 * 60_000)) ??
    (await checkRateLimitByKey(`support:new-day:${auth.userId}`, 10, 24 * 60 * 60_000));
  if (limited) return limited;

  const form = await readSupportForm(request, attachmentsEnabled());
  if (!form.ok) return form.response;
  const { fields, images } = form.value;

  const category = fields.category;
  const subject = textField(fields.subject).replace(/\s+/g, " ");
  const body = textField(fields.body);
  if (!isSupportCategory(category)) {
    return Response.json({ error: "Choose what the ticket is about." }, { status: 400 });
  }
  if (!subject || subject.length > SUBJECT_MAX) {
    return Response.json(
      { error: `Write a subject of at most ${SUBJECT_MAX} characters.` },
      { status: 400 }
    );
  }
  if (!body || body.length > BODY_MAX) {
    return Response.json(
      { error: `Describe the problem in at most ${BODY_MAX.toLocaleString("en-US")} characters.` },
      { status: 400 }
    );
  }
  const endpointId =
    typeof fields.endpointId === "string" && isUuid(fields.endpointId) ? fields.endpointId : null;

  let plan = "free";
  try {
    const { data } = await createAdminClient()
      .from("users")
      .select("plan")
      .eq("id", auth.userId)
      .maybeSingle();
    plan = data?.plan ?? "free";
  } catch {
    // The plan is context for staff only.
  }
  const from = textField(fields.from);
  const context = {
    appVersion: APP_VERSION,
    plan,
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 256),
    // Only the path: a query string can carry tokens.
    from: from.startsWith("/") ? from.split(/[?#]/, 1)[0].slice(0, 200) : "",
  };

  try {
    const ticket = await createTicket({
      userId: auth.userId,
      site: siteForHost(request.headers.get("host")),
      category,
      subject,
      body,
      blocking: boolField(fields.blocking, false),
      endpointId,
      notifyEmail: boolField(fields.notifyEmail, true),
      grantAccess: boolField(fields.grantAccess, false),
      context,
    });
    const stored = await storeAttachments(ticket.id, ticket.messageId, images);
    await auditUserAction(request, auth.userId, {
      action: "support.ticket_created",
      status: 201,
      targetId: ticket.id,
      metadata: { category, images: stored },
    });
    return Response.json(
      {
        number: ticket.number,
        imagesStored: stored,
        imagesFailed: images.length - stored,
      },
      { status: 201 }
    );
  } catch (error) {
    reportError("[support] creating a ticket failed", error);
    return Response.json({ error: "The ticket could not be sent. Try again." }, { status: 500 });
  }
}
