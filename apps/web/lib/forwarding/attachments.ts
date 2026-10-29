import type { DestinationAttachments } from "@/lib/supabase/database";
import type { RequestRecord } from "@/lib/supabase/requests";
import { attachmentLink } from "@/lib/storage/attachment-links";
import { attachmentKey } from "@/lib/storage/attachments";
import { getObjectBytes, isObjectStorageConfigured } from "@/lib/storage/object-store";

/**
 * Attachment contents in deliveries. An email kept in object storage
 * (`email.stored`) can carry its attachments: as signed download links (the
 * default), or inline as base64 while they fit in INLINE_ATTACHMENT_BYTES per
 * delivery, the rest as links. The JSON, template, Postmark and CloudMailin
 * formats read them from `email.attachments[i].content` and `.url`.
 */

/** Decoded bytes sent inline per delivery; larger attachments go as links. */
export const INLINE_ATTACHMENT_BYTES = 1024 * 1024;

export async function withAttachmentPayloads(
  request: RequestRecord,
  mode: DestinationAttachments | null | undefined
): Promise<RequestRecord> {
  const email = request.email;
  if (
    request.kind !== "email" ||
    !email?.stored ||
    email.attachments.length === 0 ||
    !mode ||
    mode === "none" ||
    !isObjectStorageConfigured()
  ) {
    return request;
  }
  let budget = mode === "inline" ? INLINE_ATTACHMENT_BYTES : 0;
  const attachments = [];
  for (const [index, attachment] of email.attachments.entries()) {
    if (budget > 0 && attachment.size <= budget) {
      const bytes = await getObjectBytes(attachmentKey(request.id, index));
      if (bytes && bytes.length <= budget) {
        budget -= bytes.length;
        attachments.push({ ...attachment, content: bytes.toString("base64") });
        continue;
      }
    }
    const url = attachmentLink(request.id, index, request.receivedAt);
    attachments.push(url ? { ...attachment, url } : attachment);
  }
  return { ...request, email: { ...email, attachments } };
}
