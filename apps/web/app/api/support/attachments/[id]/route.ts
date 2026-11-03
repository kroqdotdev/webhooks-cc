import { authenticateSessionRequest } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { staffSession } from "@/lib/staff";
import { getObject } from "@/lib/storage/object-store";
import { attachmentKey } from "@/lib/support/tickets";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/uuid";

const NOT_FOUND = () => Response.json({ error: "Not found" }, { status: 404 });

/**
 * A ticket screenshot, for the ticket's owner or for staff (with two-factor
 * sign-in). Served as an image that can never run as a page.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NOT_FOUND();

  const staff = await staffSession(request);
  let userId: string | null = null;
  if (!staff?.aal2) {
    const auth = await authenticateSessionRequest(request);
    if (!auth.success) return auth.response;
    userId = auth.userId;
  }

  try {
    const admin = createAdminClient();
    const { data: attachment, error } = await admin
      .from("support_attachments")
      .select("id, ticket_id, content_type")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!attachment) return NOT_FOUND();
    if (userId) {
      const { data: ticket } = await admin
        .from("support_tickets")
        .select("user_id")
        .eq("id", attachment.ticket_id)
        .maybeSingle();
      if (ticket?.user_id !== userId) return NOT_FOUND();
    }
    const object = await getObject(attachmentKey(attachment.ticket_id, attachment.id));
    if (!object?.body) return NOT_FOUND();
    return new Response(object.body, {
      headers: {
        "Content-Type": attachment.content_type,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    reportError("[support] serving a screenshot failed", error);
    return Response.json({ error: "The image could not be loaded." }, { status: 500 });
  }
}
