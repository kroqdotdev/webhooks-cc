import type { Condition } from "../rules";
import type { EmailField } from "./fields";

/**
 * Layouts: how an endpoint reads the emails of one sender or kind. An
 * endpoint has an ordered list; the first layout whose `match` holds is the
 * email's layout, and its fields, line items and attachment parsing apply.
 * No layout matching is a parse failure (alerts can watch for it).
 *
 * Layouts run only on webhooks.cc's servers, with RE2, so the parse is the
 * same in the dashboard, every delivery, the API and the SDKs; this module
 * only describes and checks them. The parsed result appears as `parsed` in
 * the email JSON.
 */

export const MAX_LAYOUTS = 50;
export const MAX_LAYOUT_NAME_CHARS = 100;
/** A line-item pattern's or column mapping's columns. */
export const MAX_LINE_ITEM_COLUMNS = 30;
/** Rows of line items one email produces at most. */
export const MAX_LINE_ITEMS = 1000;
export const MAX_LINE_ITEM_PATTERN_CHARS = 500;

/** Where line items come from. */
export type LineItemSource = "text" | "html" | "attachment";

export interface LineItemsSpec {
  from: LineItemSource;
  /**
   * For text and html: an RE2 pattern with named groups, found again and
   * again; each match is one row whose columns are the groups,
   * e.g. `(?P<sku>[A-Z]+-\d+)\s+(?P<qty>\d+)`.
   */
  pattern?: string;
  /** Only search after the first match of this (RE2), e.g. `Items ordered`. */
  start?: string;
  /** ... and before the first match of this after it. */
  end?: string;
  /**
   * For attachments: which one, by file name (`*` and `?` wildcards,
   * case-insensitive); the first parsed spreadsheet or CSV when left out.
   */
  attachment?: string;
  /** For attachments: the sheet, by name; the first when left out. */
  sheet?: string;
  /**
   * For attachments: columns to keep, `{ name, column }` with the header's
   * text (case-insensitive) or a column letter (A, B, ...); every column by
   * its header when left out.
   */
  columns?: { name: string; column: string }[];
}

export interface Layout {
  /** Stable id (letters, digits, - and _), how alerts and the API refer to it. */
  id: string;
  name: string;
  /** Off: kept, but never matched. */
  enabled?: boolean;
  /** When this layout applies; no conditions: every email. Fields: email (subject, from, to, text, tag), headers, email_auth, spam_score. */
  match?: { logic?: "and" | "or"; conditions: Condition[] };
  /** Named values, as an endpoint's email fields. */
  fields?: EmailField[];
  lineItems?: LineItemsSpec | null;
  /** Parse its attachments (CSV, TSV, XLSX, XLS, ODS, PDF text, TXT, JSON, XML, ICS); pages are metered. */
  parseAttachments?: boolean;
}

/** One parsed attachment in the result. */
export interface ParsedAttachment {
  index: number;
  filename: string | null;
  /** csv, tsv, xlsx, xls, ods, pdf or text. */
  format: string;
  /** Billable pages this parse used. */
  pages: number;
  /** For spreadsheets: each sheet's name, rows (first 1,000 inline) and row count. */
  sheets?: { name: string | null; rows: string[][]; rowCount: number; truncated: boolean }[];
  /** For PDFs and text: the text, cut at 256 KB. */
  text?: string | null;
  /** Stopped at the per-file page cap. */
  truncated?: boolean;
  /**
   * Why it was not parsed or failed: "limit" (no pages left), "not_kept"
   * (the email's attachments were not stored), "not_parsed" (a preview, which
   * never parses), "too_large", "malformed", "encrypted", "zip_bomb", "empty".
   */
  error?: string | null;
}

/** `parsed` in the email JSON: what the endpoint's layouts found. */
export interface ParsedEmail {
  /** "matched": a layout applied; "no_layout": none matched (a parse failure). */
  status: "matched" | "no_layout";
  layout: { id: string; name: string } | null;
  fields: Record<string, string | null>;
  lineItems: Record<string, string | null>[];
  attachments: ParsedAttachment[];
  /** Pages this email used. */
  pages: number;
}
