import type { Request } from "@webhooks-cc/sdk";

/** Tool output past this many characters is cut (see serializeJson in tools.ts). */
export const MAX_OUTPUT = 32_768;

/** An email's text part is cut to this many characters in tool and resource output. */
export const MAX_EMAIL_TEXT = 8_000;

/** At most this many codes and links are listed for one email once it has to shrink. */
const MAX_EXTRACTS = 10;
/** Longest link text and URL kept in a list of links once an email has to shrink. */
const MAX_LINK_TEXT = 200;
export const MAX_LINK_URL = 2_000;
/** Addresses and attachments kept per list once an email has to shrink. */
const MAX_LIST_ITEMS = 5;

/** The address and attachment lists of an email that can be shortened. */
const EMAIL_LISTS = ["from", "to", "cc", "replyTo", "sender", "inReplyTo", "attachments"];

/**
 * Text kept while other fields can still go: the text is cut to this many
 * characters before an email drops to its essentials, and only below it once
 * the essentials alone are too big.
 */
export const TEXT_FLOOR = 2_000;

type JsonObject = Record<string, unknown>;

/** The length of `value` as tool output prints it. */
export function jsonSize(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

/** The first `end` UTF-16 units of `text`, one fewer if that would split a surrogate pair. */
export function sliceText(text: string, end: number): string {
  if (end <= 0) return "";
  if (end >= text.length) return text;
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/** A text part cut to `MAX_EMAIL_TEXT`, and whether it was cut. */
export function cutEmailText(text: string | null): { text: string | null; cut: boolean } {
  if (text === null || text.length <= MAX_EMAIL_TEXT) return { text, cut: false };
  return { text: sliceText(text, MAX_EMAIL_TEXT), cut: true };
}

/**
 * Runs `steps` in order, each only while `root` is still over `budget`, so
 * the cheapest loss comes first. The last step must always bring it under.
 */
export function shrinkToFit(root: unknown, budget: number, steps: (() => void)[]): void {
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

/** Keeps the first codes and links of an email and shortens long link texts and URLs. */
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
      ...(typeof link.url === "string" ? { url: sliceText(link.url, MAX_LINK_URL) } : {}),
      ...(typeof link.text === "string" ? { text: sliceText(link.text, MAX_LINK_TEXT) } : {}),
    }));
  }
}

/** Keeps the first entries of each address and attachment list, with the full count beside it. */
export function capLists(holder: JsonObject): void {
  for (const key of EMAIL_LISTS) {
    const list = holder[key];
    if (Array.isArray(list) && list.length > MAX_LIST_ITEMS) {
      holder[key] = list.slice(0, MAX_LIST_ITEMS);
      holder[`${key}Total`] = list.length;
    }
  }
}

/** Removes every field of `holder` except `keep`, and says so in `holder.trimmed`. */
export function keepOnly(holder: JsonObject, keep: readonly string[]): void {
  for (const key of Object.keys(holder)) {
    if (!keep.includes(key)) delete holder[key];
  }
  holder.trimmed = "The email was too big for the output, so only these fields are shown.";
}

/**
 * Cuts the string `holder[key]` to the longest start that keeps `root`
 * within `budget`, but never below `floor` characters (the root may then
 * still be over budget, for a later step), and sets `holder[flag]` when it
 * cut anything.
 */
export function cutStringToFit(
  root: unknown,
  holder: JsonObject,
  key: string,
  flag: string,
  budget: number,
  floor = 0
): void {
  const value = holder[key];
  if (typeof value !== "string" || value.length <= floor) return;
  const flagged = holder[flag] === true;
  holder[key] = "";
  holder[flag] = true;
  // The serialized slice takes the place of the two characters of "".
  const room = budget - jsonSize(root) + 2;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(sliceText(value, mid)).length <= room) low = mid;
    else high = mid - 1;
  }
  const kept = sliceText(value, Math.max(low, floor));
  holder[key] = kept;
  if (kept.length === value.length && !flagged) delete holder[flag];
}

/** Keeps only the first entry of the list `holder[key]`, with the full count in `${key}Total`. */
export function keepFirst(holder: JsonObject, key: string): void {
  const list = holder[key];
  if (!Array.isArray(list) || list.length <= 1) return;
  holder[`${key}Total`] = holder[`${key}Total`] ?? list.length;
  holder[key] = list.slice(0, 1);
}

type CompactableRequest = Pick<Request, "kind" | "body" | "bodyRaw" | "email">;

/** An email as `compactRequest` returns it: no raw message, no HTML part, the text cut. */
export interface CompactEmailRequest {
  kind: "email";
  rawMessageOmitted: string;
  [field: string]: unknown;
}

/** Fields of `email` kept when an email in a request has to shrink to its essentials. */
const ESSENTIAL_EMAIL_FIELDS = [
  "subject",
  "from",
  "fromTotal",
  "tag",
  "date",
  "text",
  "textTruncated",
  "htmlSize",
];

/**
 * A request as tools and resources return it. HTTP requests come back as
 * they are. An email's `body` is the raw MIME message (up to 1 MB) and its
 * HTML part can reach 256 KB, either of which would use up the output
 * budget: both are left out and the text part is cut. An email that is still
 * too big loses its headers, then the extra entries of its sender, address
 * and attachment lists, then text down to TEXT_FLOOR characters, then
 * everything but its subject, first sender, tag, date and as much text as
 * then fits, and at last part of its subject, so it always fits a list on
 * its own.
 * `size` keeps the message's size in bytes, and `get_email` returns the HTML.
 */
export function compactRequest<T extends CompactableRequest>(request: T): T | CompactEmailRequest {
  if (request.kind !== "email") return request;
  const compact: JsonObject = { ...request };
  delete compact.body;
  delete compact.bodyRaw;
  compact.rawMessageOmitted =
    "The raw message and the HTML part are left out; size is the message size in bytes. get_email returns the HTML.";
  if (!request.email) return compact as CompactEmailRequest;

  const { html, ...rest } = request.email;
  const { text, cut } = cutEmailText(rest.text);
  const restoreText = () => {
    email.text = text;
    if (cut) email.textTruncated = true;
    else delete email.textTruncated;
  };
  const email: JsonObject = {
    ...rest,
    text,
    ...(cut ? { textTruncated: true } : {}),
    htmlSize: html?.length ?? 0,
  };
  compact.email = email;
  // Measured as an item of a cut list, the deepest place tools print it.
  const root = { items: [compact], truncated: true, total: 1_000, returned: 1_000 };
  const budget = MAX_OUTPUT - 128;
  shrinkToFit(root, budget, [
    () => omitHeaders(compact),
    () => capLists(email),
    () => cutStringToFit(root, email, "text", "textTruncated", budget, TEXT_FLOOR),
    // Down to the essentials there may be room for more of the text again.
    () => {
      keepOnly(email, ESSENTIAL_EMAIL_FIELDS);
      keepFirst(email, "from");
      restoreText();
      cutStringToFit(root, email, "text", "textTruncated", budget);
    },
    () => cutStringToFit(root, email, "subject", "subjectTruncated", budget),
  ]);
  return compact as CompactEmailRequest;
}
