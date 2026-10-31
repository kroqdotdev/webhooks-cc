import {
  EMAIL_TEMPLATE_ROOTS,
  REQUEST_TEMPLATE_ROOTS,
  renderTemplate,
  unknownPlaceholders,
} from "@webhooks-cc/sdk";
import type { EmailField } from "@webhooks-cc/sdk/email";
import type { Json } from "@/lib/supabase/database";
import type { RequestRecord } from "@/lib/supabase/requests";
import { templateContextFor } from "@/lib/request-context";

/**
 * The Google Sheets destination: each captured request (or, from phase 2,
 * each line item) becomes a row. Its settings live in
 * endpoint_destinations.config; each column is a header and a value written
 * with the forwarding placeholders, such as `{{ subject }}` or
 * `{{ fields.order }}`.
 */

export const MAX_COLUMNS = 50;
const MAX_HEADER_CHARS = 200;
const MAX_VALUE_CHARS = 1000;
/** Google's limit for one cell. */
export const MAX_CELL_CHARS = 50_000;

export interface SheetsColumn {
  header: string;
  value: string;
}

export interface SheetsConfig {
  connectionId: string;
  spreadsheetId: string;
  /** The tab rows go to. */
  sheet: string;
  /** "email": a row per request; "line_items": a row per line item (phase 2). */
  rows: "email" | "line_items";
  columns: SheetsColumn[];
}

/** The columns a new sheet starts with: when, who, what, and each email field. */
export function defaultColumns(emailFields: readonly EmailField[] = []): SheetsColumn[] {
  return [
    { header: "Received", value: "{{ receivedAt }}" },
    { header: "From", value: "{{ from.address }}" },
    { header: "Subject", value: "{{ subject }}" },
    ...emailFields.map((field) => ({ header: field.name, value: `{{ fields.${field.name} }}` })),
  ];
}

/** Checks a config as the API receives it; the config, or what is wrong. */
export function parseSheetsConfig(
  value: unknown,
  kinds: { http: boolean; email: boolean }
): SheetsConfig | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "config must say which spreadsheet and columns to use.";
  }
  const config = value as Record<string, unknown>;
  if (typeof config.connectionId !== "string" || !/^[0-9a-f-]{36}$/i.test(config.connectionId)) {
    return "config.connectionId must be one of your connected Google accounts.";
  }
  if (
    typeof config.spreadsheetId !== "string" ||
    !/^[A-Za-z0-9_-]{20,100}$/.test(config.spreadsheetId)
  ) {
    return "config.spreadsheetId is not a Google Sheets id.";
  }
  const sheet =
    typeof config.sheet === "string" && config.sheet.trim() ? config.sheet.trim() : "Sheet1";
  if (sheet.length > 100) return "config.sheet is at most 100 characters.";
  const rows = config.rows === undefined ? "email" : config.rows;
  if (rows !== "email" && rows !== "line_items") return 'config.rows is "email" or "line_items".';
  const columns = parseColumns(config.columns, kinds, rows, "config.columns");
  if (typeof columns === "string") return columns;
  return {
    connectionId: config.connectionId,
    spreadsheetId: config.spreadsheetId,
    sheet,
    rows,
    columns,
  };
}

/**
 * Columns as the API receives them: each a header and a value with the
 * placeholders of what the destination takes (and `item` for a row per line
 * item). Shared with file drops' CSV and XML (lib/drops/config.ts).
 */
export function parseColumns(
  value: unknown,
  kinds: { http: boolean; email: boolean },
  rows: "email" | "line_items",
  label: string
): SheetsColumn[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return `${label} needs at least one column.`;
  }
  if (value.length > MAX_COLUMNS) return `${label} has at most ${MAX_COLUMNS} columns.`;
  const roots = [
    ...new Set([
      ...(kinds.http ? REQUEST_TEMPLATE_ROOTS : []),
      ...(kinds.email ? EMAIL_TEMPLATE_ROOTS : []),
      ...(rows === "line_items" ? ["item"] : []),
    ]),
  ];
  const columns: SheetsColumn[] = [];
  for (const [index, column] of (value as unknown[]).entries()) {
    const c = column as Record<string, unknown> | null;
    if (!c || typeof c.header !== "string" || typeof c.value !== "string" || !c.header.trim()) {
      return `Column ${index + 1} needs a header and a value.`;
    }
    if (c.header.length > MAX_HEADER_CHARS || c.value.length > MAX_VALUE_CHARS) {
      return `Column ${index + 1} is too long.`;
    }
    const unknown = unknownPlaceholders(c.value, roots);
    if (unknown.length > 0)
      return `Column ${index + 1} uses an unknown placeholder: ${unknown[0]}.`;
    columns.push({ header: c.header, value: c.value });
  }
  return columns;
}

/** A stored config, or null when it is missing or malformed. */
export function storedSheetsConfig(value: Json | null | undefined): SheetsConfig | null {
  const parsed = parseSheetsConfig(value, { http: true, email: true });
  return typeof parsed === "string" ? null : parsed;
}

function cell(text: string): string {
  return text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text;
}

/**
 * The most text one request's rows may hold. A column repeated for each of
 * up to 1,000 line items (50 columns of 50,000 characters each) would
 * otherwise build gigabytes before anything could refuse it.
 */
export const MAX_ROWS_CHARS = 50 * 1024 * 1024;

/** One request's rows would hold more than they may. */
export class RowsTooLargeError extends Error {
  constructor() {
    super("This request makes more rows than fit.");
    this.name = "RowsTooLargeError";
  }
}

/** The rows one captured request adds; RowsTooLargeError past `maxChars` characters. */
export function rowsFor(
  request: RequestRecord,
  config: Pick<SheetsConfig, "rows" | "columns">,
  endpoint: { slug: string; name: string | null },
  options: {
    includeExtracts: boolean;
    fields: Record<string, string | null> | null;
    maxChars?: number;
  }
): string[][] {
  const context = templateContextFor(request, endpoint, options);
  // Line items arrive with layouts (phase 2); until an email has any, it is one row.
  const items = lineItemsOf(context);
  const contexts =
    config.rows === "line_items" && items.length > 0
      ? items.map((item) => ({ ...context, item }))
      : [context];
  const maxChars = options.maxChars ?? MAX_ROWS_CHARS;
  let total = 0;
  return contexts.map((ctx) =>
    config.columns.map((column) => {
      // Each cell is cut while it is filled in, so a long value is never built in full.
      const value = cell(
        renderTemplate(column.value, ctx, { mode: "text", maxBytes: MAX_CELL_CHARS * 4 })
      );
      total += value.length;
      if (total > maxChars) throw new RowsTooLargeError();
      return value;
    })
  );
}

function lineItemsOf(context: Record<string, unknown>): Record<string, unknown>[] {
  const parsed = context.parsed as { lineItems?: unknown } | undefined;
  return Array.isArray(parsed?.lineItems)
    ? (parsed.lineItems as Record<string, unknown>[]).slice(0, 1000)
    : [];
}
