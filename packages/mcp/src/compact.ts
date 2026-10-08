import type { Request } from "@webhooks-cc/sdk";

/** An email's text part is cut to this many characters in tool and resource output. */
export const MAX_EMAIL_TEXT = 8_000;

/** A text part cut to `MAX_EMAIL_TEXT`, and whether it was cut. */
export function cutEmailText(text: string | null): { text: string | null; cut: boolean } {
  if (text === null || text.length <= MAX_EMAIL_TEXT) return { text, cut: false };
  return { text: text.slice(0, MAX_EMAIL_TEXT), cut: true };
}

type CompactableRequest = Pick<Request, "kind" | "body" | "bodyRaw" | "email">;

/**
 * A request as tools and resources return it. An email's `body` is the raw
 * MIME message (up to 1 MB) and its HTML part can reach 256 KB, either of
 * which would use up the output budget. Both are left out and the text part
 * is cut; `size` keeps the message's size in bytes and `get_email` returns
 * the HTML.
 */
export function compactRequest<T extends CompactableRequest>(request: T): T {
  if (request.kind !== "email") return request;
  const compact: Record<string, unknown> = { ...request };
  delete compact.body;
  delete compact.bodyRaw;
  if (request.email) {
    const { html, ...email } = request.email;
    const { text, cut } = cutEmailText(email.text);
    compact.email = {
      ...email,
      text,
      ...(cut ? { textTruncated: true } : {}),
      htmlSize: html?.length ?? 0,
    };
  }
  compact.rawMessageOmitted =
    "The raw message and the HTML part are left out; size is the message size in bytes. get_email returns the HTML.";
  return compact as T;
}
