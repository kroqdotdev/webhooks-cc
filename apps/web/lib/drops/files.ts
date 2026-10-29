/**
 * What a file drop writes: CSV or XML rows from the destination's columns
 * (the same column model as the Google Sheets destination: a header and a
 * value written with placeholders, a row per request or per line item), or
 * JSON documents (the email JSON or request JSON forwarding sends). One
 * file per request, or one per batch.
 *
 * Names are stable: the same request, or a batch starting with the same
 * request, always gets the same name, so a retry after an upload that went
 * through replaces the file instead of adding a second one.
 */

export type DropFileFormat = "csv" | "json" | "xml";

export interface DropFile {
  name: string;
  data: Buffer;
  contentType: string;
}

const CONTENT_TYPES: Record<DropFileFormat, string> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  xml: "application/xml; charset=utf-8",
};

/** A file name prefix as typed, kept to safe characters. */
export function cleanPrefix(prefix: string | null | undefined): string {
  return (prefix ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 60);
}

function stamp(receivedAt: string): string {
  const date = new Date(receivedAt);
  const valid = Number.isFinite(date.getTime()) ? date : new Date(0);
  return valid
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
}

/** prefix + 20261029-173326 + the first 8 characters of the (first) request's id. */
export function dropFileName(
  prefix: string | null | undefined,
  first: { id: string; receivedAt: string },
  format: DropFileFormat,
  batch: boolean
): string {
  const id = first.id.replace(/[^0-9a-f]/gi, "").slice(0, 8);
  return `${cleanPrefix(prefix)}${stamp(first.receivedAt)}-${id}${batch ? "-batch" : ""}.${format}`;
}

/** A cell a spreadsheet would read as a formula starts with a quote, so it stays text. */
function csvSafe(value: string): string {
  if (/^[=@\t\r]/.test(value) || /^[+-][^0-9\s.]/.test(value)) return `'${value}`;
  return value;
}

function csvCell(value: string): string {
  const safe = csvSafe(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildCsv(headers: string[], rows: string[][]): Buffer {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

/** Characters XML 1.0 cannot hold at all are dropped. */
function xmlText(value: string): string {
  return value
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A column header as an element name: letters, digits, _ . -, never starting with a digit or "xml". */
export function xmlName(header: string): string {
  let name = header
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) name = "field";
  if (/^[0-9.-]/.test(name) || /^xml/i.test(name)) name = `_${name}`;
  return name.slice(0, 64);
}

export function buildXml(headers: string[], rows: string[][]): Buffer {
  const names = headers.map(xmlName);
  const body = rows
    .map(
      (row) =>
        `  <row>\n${row.map((value, i) => `    <${names[i]}>${xmlText(value)}</${names[i]}>`).join("\n")}\n  </row>`
    )
    .join("\n");
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n${body}${body ? "\n" : ""}</rows>\n`,
    "utf8"
  );
}

export function buildJson(documents: unknown[], batch: boolean): Buffer {
  return Buffer.from(`${JSON.stringify(batch ? documents : documents[0], null, 2)}\n`, "utf8");
}

export function dropFile(
  format: DropFileFormat,
  name: string,
  content: { headers: string[]; rows: string[][]; documents: unknown[]; batch: boolean }
): DropFile {
  const data =
    format === "csv"
      ? buildCsv(content.headers, content.rows)
      : format === "xml"
        ? buildXml(content.headers, content.rows)
        : buildJson(content.documents, content.batch);
  return { name, data, contentType: CONTENT_TYPES[format] };
}
