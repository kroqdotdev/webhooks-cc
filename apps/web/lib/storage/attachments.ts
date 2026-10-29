import type { EmailAttachment } from "@webhooks-cc/sdk/email";
import { contentDisposition } from "./object-store";

/** Where attachment `index` of a stored email is. */
export function attachmentKey(requestId: string, index: number): string {
  return `m/${requestId}/a/${index}`;
}

/** An attachment index from a route segment, or null. */
export function parseAttachmentIndex(value: string): number | null {
  if (!/^\d{1,3}$/.test(value)) return null;
  const index = Number(value);
  return index < 100 ? index : null;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The name a download gets: the attachment's own, or a stand-in. */
export function attachmentFilename(attachment: EmailAttachment, index: number): string {
  const name = attachment.filename?.trim();
  return name ? name.slice(0, 255) : `attachment-${index + 1}`;
}

/**
 * Headers for serving an attachment from our own origin: always a download,
 * never rendered (an HTML or SVG attachment is anyone's markup), and the
 * declared type only when it is a plain media type.
 */
export function attachmentHeaders(attachment: EmailAttachment, index: number): HeadersInit {
  const type = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
    attachment.contentType
  )
    ? attachment.contentType
    : "application/octet-stream";
  return {
    "content-type": type,
    "content-disposition": contentDisposition(attachmentFilename(attachment, index)),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "private, no-store",
  };
}
