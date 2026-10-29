import type { ParsedAttachment, ParsedEmail } from "@webhooks-cc/sdk/email";

/**
 * Keeps a parsed result small enough to travel with the email: it goes into
 * every delivery's JSON, the dashboard and the API, while the full parse of
 * each file stays in object storage. Senders control every byte of an
 * attachment, so the inline result is cut by bytes, not only by rows.
 */

/** The parsed result inline, as JSON, at most. */
export const MAX_PARSED_BYTES = 1024 * 1024;
/** One attachment's inline rows and text together, at most. */
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
/** One cell or line item value, in characters. */
export const MAX_CELL_CHARS = 1000;

/**
 * The first `max` UTF-16 units of `text`, one fewer when that would split a
 * surrogate pair: half an emoji is not valid JSON for Postgres.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** One attachment's sheets and text cut to its share of the budget. */
export function fitAttachment(
  attachment: ParsedAttachment,
  budget = MAX_ATTACHMENT_BYTES
): ParsedAttachment {
  let used = 0;
  let truncated = attachment.truncated ?? false;
  const sheets = attachment.sheets?.map((sheet) => {
    const rows: string[][] = [];
    for (const row of sheet.rows) {
      const cells = row.map((cell) => clipText(cell, MAX_CELL_CHARS));
      const bytes = size(cells);
      if (used + bytes > budget) {
        truncated = true;
        return { ...sheet, rows, truncated: true };
      }
      used += bytes;
      rows.push(cells);
    }
    return { ...sheet, rows };
  });
  let text = attachment.text;
  if (typeof text === "string") {
    const room = Math.max(budget - used, 0);
    if (Buffer.byteLength(text) > room) {
      // Characters can be up to 4 bytes; cut by characters, then check.
      text = clipText(text, room);
      while (Buffer.byteLength(text) > room) text = clipText(text, Math.floor(text.length * 0.9));
      truncated = true;
    }
  }
  return {
    ...attachment,
    ...(sheets ? { sheets } : {}),
    ...(attachment.text !== undefined ? { text } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * The whole result within MAX_PARSED_BYTES: each attachment within its own
 * budget first; then, while it is still too large, the attachments' rows
 * and text go (their counts stay), then line items from the end. `truncated`
 * says something was cut; the stored parse has all of it.
 */
export function fitParsed(parsed: ParsedEmail, max = MAX_PARSED_BYTES): ParsedEmail {
  const lineItems = parsed.lineItems.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value === null ? null : clipText(value, MAX_CELL_CHARS),
      ])
    )
  );
  let result: ParsedEmail = {
    ...parsed,
    lineItems,
    attachments: parsed.attachments.map((attachment) => fitAttachment(attachment)),
  };
  if (size(result) <= max) return result;
  result = {
    ...result,
    truncated: true,
    attachments: result.attachments.map(({ sheets, text, ...rest }) => ({
      ...rest,
      ...(sheets
        ? {
            sheets: sheets.map((sheet) => ({
              name: sheet.name,
              rows: [],
              rowCount: sheet.rowCount,
              truncated: true,
            })),
          }
        : {}),
      ...(text !== undefined ? { text: null } : {}),
      truncated: true,
    })),
  };
  if (size(result) <= max) return result;
  // Line items last: halve until they fit.
  let keep = result.lineItems.length;
  while (keep > 0 && size({ ...result, lineItems: result.lineItems.slice(0, keep) }) > max) {
    keep = Math.floor(keep / 2);
  }
  return { ...result, lineItems: result.lineItems.slice(0, keep) };
}
