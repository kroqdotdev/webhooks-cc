import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { getRequestByIdForUser } from "@/lib/supabase/requests";
import { getObject, isObjectStorageConfigured } from "@/lib/storage/object-store";
import { attachmentHeaders, attachmentKey, parseAttachmentIndex } from "@/lib/storage/attachments";

/**
 * GET /api/requests/{id}/attachments/{index}: one attachment of a captured
 * email, as a download. Only emails kept in object storage (`email.stored`)
 * have their attachments' contents.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; index: string }> }
) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { id, index: indexParam } = await params;
  const index = parseAttachmentIndex(indexParam);
  if (index === null) return Response.json({ error: "invalid_index" }, { status: 400 });

  try {
    const record = await getRequestByIdForUser(auth.userId, id);
    if (!record) return Response.json({ error: "not_found" }, { status: 404 });
    const attachment = record.email?.attachments[index];
    if (record.kind !== "email" || !attachment) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (!record.email?.stored || !isObjectStorageConfigured()) {
      return Response.json(
        { error: "not_kept", message: "This email's attachment contents were not kept." },
        { status: 404 }
      );
    }
    const object = await getObject(attachmentKey(record.id, index));
    if (!object?.body) return Response.json({ error: "not_found" }, { status: 404 });
    const length = object.headers.get("content-length");
    return new Response(object.body, {
      headers: {
        ...(attachmentHeaders(attachment, index) as Record<string, string>),
        ...(length ? { "content-length": length } : {}),
      },
    });
  } catch (error) {
    reportError("Failed to read an attachment", error);
    return Response.json({ error: "Failed to read the attachment" }, { status: 500 });
  }
}
