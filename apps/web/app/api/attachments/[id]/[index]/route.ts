import { reportError } from "@/lib/observability";
import { toEmailCapture } from "@/lib/email-capture";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRetainedRequestsByIds } from "@/lib/supabase/requests";
import { isObjectStorageConfigured, presignGet } from "@/lib/storage/object-store";
import { verifyAttachmentLink } from "@/lib/storage/attachment-links";
import {
  attachmentFilename,
  attachmentKey,
  parseAttachmentIndex,
  UUID,
} from "@/lib/storage/attachments";

/** How long the storage link this hands out works; a client follows it at once. */
const PRESIGN_SECONDS = 300;

/**
 * GET /api/attachments/{id}/{index}?e=&s=: the signed links deliveries
 * carry (lib/storage/attachment-links.ts). No session: the signature is the
 * permission. Answers with a short-lived link straight to object storage, so
 * the bytes never pass through this server.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; index: string }> }
) {
  const { id, index: indexParam } = await params;
  const index = parseAttachmentIndex(indexParam);
  const url = new URL(request.url);
  if (
    !UUID.test(id) ||
    index === null ||
    !verifyAttachmentLink(id, index, url.searchParams.get("e"), url.searchParams.get("s"))
  ) {
    return Response.json({ error: "invalid_link" }, { status: 403 });
  }
  if (!isObjectStorageConfigured()) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const { data, error } = await createAdminClient()
      .from("requests")
      .select("id, endpoint_id, kind, email")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    // Past retention the link ends too, whether or not the cleanup has
    // deleted the email yet.
    const retained =
      data?.kind === "email" && data.endpoint_id
        ? (await getRetainedRequestsByIds(data.endpoint_id, [data.id])).length > 0
        : false;
    const email = retained ? toEmailCapture(data!.email) : null;
    const attachment = email?.attachments[index];
    // Gone with the email (retention, or deleted), or never stored.
    if (!email?.stored || !attachment) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const location = await presignGet(
      attachmentKey(id, index),
      PRESIGN_SECONDS,
      attachmentFilename(attachment, index),
      "application/octet-stream"
    );
    return new Response(null, {
      status: 302,
      headers: {
        location,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    reportError("Failed to resolve an attachment link", error);
    return Response.json({ error: "Failed to read the attachment" }, { status: 500 });
  }
}
