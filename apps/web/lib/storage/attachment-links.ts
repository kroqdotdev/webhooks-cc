import { createHmac, timingSafeEqual } from "node:crypto";
import { publicEnv } from "@/lib/env";

/**
 * Signed download links for stored attachments, as deliveries carry them:
 * `/api/attachments/{requestId}/{index}?e={expires}&s={signature}`. Anyone
 * holding a link may download that one attachment until it expires or the
 * email is deleted (retention), whichever comes first; the route then hands
 * out a short-lived presigned storage link. The key is derived from
 * SIGNING_SECRET_KEY, so no new secret is needed and rotating that key
 * retires every link.
 */

/** Links outlive the longest retention; the email's deletion ends them sooner. */
export const LINK_LIFETIME_MS = 91 * 24 * 60 * 60 * 1000;

function linkKey(): Buffer | null {
  const raw = process.env.SIGNING_SECRET_KEY;
  if (!raw) return null;
  return createHmac("sha256", Buffer.from(raw, "base64"))
    .update("webhooks.cc attachment links v1")
    .digest();
}

function signature(key: Buffer, requestId: string, index: number, expires: number): string {
  return createHmac("sha256", key).update(`${requestId}.${index}.${expires}`).digest("base64url");
}

/** The link for attachment `index` of a stored email, or null without a key. */
export function attachmentLink(
  requestId: string,
  index: number,
  receivedAt: number,
  appUrl = publicEnv().NEXT_PUBLIC_APP_URL
): string | null {
  const key = linkKey();
  if (!key) return null;
  const expires = Math.floor((receivedAt + LINK_LIFETIME_MS) / 1000);
  const url = new URL(
    `/api/attachments/${encodeURIComponent(requestId)}/${index}`,
    appUrl.replace(/\/+$/, "") + "/"
  );
  url.searchParams.set("e", String(expires));
  url.searchParams.set("s", signature(key, requestId, index, expires));
  return url.toString();
}

/** Whether a link's parameters are genuine and unexpired. */
export function verifyAttachmentLink(
  requestId: string,
  index: number,
  expires: string | null,
  sig: string | null,
  now = Date.now()
): boolean {
  const key = linkKey();
  if (!key || !expires || !sig || !/^\d{1,12}$/.test(expires)) return false;
  const expiresAt = Number(expires);
  if (expiresAt * 1000 < now) return false;
  const expected = Buffer.from(signature(key, requestId, index, expiresAt));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
