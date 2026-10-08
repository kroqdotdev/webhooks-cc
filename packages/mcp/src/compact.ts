import type { Request } from "@webhooks-cc/sdk";

/** Tool output past this many characters is cut (see serializeJson in tools.ts). */
export const MAX_OUTPUT = 32_768;

/**
 * One email in request tools and resources stays under this many characters
 * of JSON, so a list always fits at least one. The margin covers the deeper
 * indentation inside a list and the wrapper of a cut list.
 */
const EMAIL_BUDGET = MAX_OUTPUT - 2_048;

/** An email's text part is cut to this many characters in tool and resource output. */
export const MAX_EMAIL_TEXT = 8_000;

/** At most this many codes and links are listed for one email. */
const MAX_EXTRACTS = 10;
/** Longest link label and URL kept in a list of links. */
const MAX_LINK_LABEL = 200;
const MAX_LINK_URL = 2_000;

type JsonObject = Record<string, unknown>;

/** The length of `value` as tool output prints it. */
export function jsonSize(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

/** A text part cut to `MAX_EMAIL_TEXT`, and whether it was cut. */
export function cutEmailText(text: string | null): { text: string | null; cut: boolean } {
  if (text === null || text.length <= MAX_EMAIL_TEXT) return { text, cut: false };
  return { text: text.slice(0, MAX_EMAIL_TEXT), cut: true };
}

/**
 * Runs `steps` in order, each only while `root` is still over `budget`, so
 * the cheapest loss comes first. Something can still be over budget after
 * the last step; serializeJson cuts that.
 */
export function shrinkToFit(root: JsonObject, budget: number, steps: (() => void)[]): void {
  for (const step of steps) {
    if (jsonSize(root) <= budget) return;
    step();
  }
}

/** Replaces `holder.headers` with an empty object and a note saying how many were left out. */
export function omitHeaders(holder: JsonObject): void {
  const headers = holder.headers;
  if (headers === null || typeof headers !== "object") return;
  const count = Object.keys(headers).length;
  if (count === 0) return;
  holder.headers = {};
  holder.headersOmitted = `${count} headers left out to fit the output`;
}

/** Keeps the first codes and links of an email and shortens long link labels and URLs. */
export function capExtracts(holder: JsonObject): void {
  if (Array.isArray(holder.codes) && holder.codes.length > MAX_EXTRACTS) {
    holder.codes = holder.codes.slice(0, MAX_EXTRACTS);
    holder.codesTruncated = true;
  }
  if (Array.isArray(holder.links)) {
    if (holder.links.length > MAX_EXTRACTS) {
      holder.links = holder.links.slice(0, MAX_EXTRACTS);
      holder.linksTruncated = true;
    }
    holder.links = (holder.links as JsonObject[]).map((link) => ({
      ...link,
      ...(typeof link.url === "string" ? { url: link.url.slice(0, MAX_LINK_URL) } : {}),
      ...(typeof link.label === "string" ? { label: link.label.slice(0, MAX_LINK_LABEL) } : {}),
    }));
  }
}

/**
 * Cuts the string `holder[key]` to the longest start that keeps `root`
 * within `budget`, and sets `holder[flag]` when it cut anything.
 */
export function cutStringToFit(
  root: JsonObject,
  holder: JsonObject,
  key: string,
  flag: string,
  budget: number
): void {
  const value = holder[key];
  if (typeof value !== "string" || value === "") return;
  holder[key] = "";
  holder[flag] = true;
  // The serialized slice takes the place of the two characters of "".
  const room = budget - jsonSize(root) + 2;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(value.slice(0, mid)).length <= room) low = mid;
    else high = mid - 1;
  }
  holder[key] = value.slice(0, low);
}

type CompactableRequest = Pick<Request, "kind" | "body" | "bodyRaw" | "email">;

/** An email as `compactRequest` returns it: no raw message, no HTML part, the text cut. */
export interface CompactEmailRequest {
  kind: "email";
  rawMessageOmitted: string;
  [field: string]: unknown;
}

/**
 * A request as tools and resources return it. HTTP requests come back as
 * they are. An email's `body` is the raw MIME message (up to 1 MB) and its
 * HTML part can reach 256 KB, either of which would use up the output
 * budget: both are left out and the text part is cut, and if the email is
 * still too big, its headers go and then more of its text. `size` keeps the
 * message's size in bytes, and `get_email` returns the HTML.
 */
export function compactRequest<T extends CompactableRequest>(request: T): T | CompactEmailRequest {
  if (request.kind !== "email") return request;
  const compact: JsonObject = { ...request };
  delete compact.body;
  delete compact.bodyRaw;
  let email: JsonObject | null = null;
  if (request.email) {
    const { html, ...rest } = request.email;
    const { text, cut } = cutEmailText(rest.text);
    email = { ...rest, text, ...(cut ? { textTruncated: true } : {}), htmlSize: html?.length ?? 0 };
    compact.email = email;
  }
  compact.rawMessageOmitted =
    "The raw message and the HTML part are left out; size is the message size in bytes. get_email returns the HTML.";
  shrinkToFit(compact, EMAIL_BUDGET, [
    () => omitHeaders(compact),
    () => email && cutStringToFit(compact, email, "text", "textTruncated", EMAIL_BUDGET),
  ]);
  return compact as CompactEmailRequest;
}
