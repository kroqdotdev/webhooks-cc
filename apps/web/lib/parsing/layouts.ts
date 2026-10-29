import { RE2JS } from "re2js";
import { globToRegexSource, layoutIssues } from "@webhooks-cc/sdk";
import {
  extractEmailFields,
  htmlToText,
  MAX_LINE_ITEMS,
  type Layout,
  type LineItemsSpec,
  type ParsedAttachment,
} from "@webhooks-cc/sdk/email";
import { conditionsHold } from "@/lib/rules";
import { fieldPatternProblem, re2Find, MAX_FIELD_PROGRAM } from "@/lib/email-fields";
import { ruleSubjectFor } from "@/lib/request-context";
import type { RequestRecord } from "@/lib/supabase/requests";
import type { ParserSheet } from "./parser";

/**
 * Layouts as the server runs them: which one an email matches (the rule
 * language), its fields (RE2, as email fields) and its line items (an RE2
 * pattern with named groups found again and again, or a sheet's rows with a
 * column mapping). Every pattern is RE2 with a bounded program, and every
 * text read is bounded, so a layout cannot stall the parse worker however
 * hostile the email.
 */

/** Text a line-item pattern reads at most. */
const MAX_LINE_ITEM_TEXT = 512 * 1024;
const MAX_CELL = 1000;
/** A layout list's patterns together, in compiled steps. */
const MAX_LAYOUTS_PROGRAM = 20_000;

function programSize(pattern: string): number {
  try {
    return RE2JS.compile(pattern).programSize();
  } catch {
    return 0;
  }
}

/** What is wrong with a layout list, RE2 syntax and size included; empty when valid. */
export function layoutsProblems(layouts: unknown, cap: number): string[] {
  const problems = layoutIssues(layouts, fieldPatternProblem);
  if (problems.length > 0 || !Array.isArray(layouts)) return problems;
  if (layouts.length > cap) {
    return [`your plan allows ${cap} layouts per endpoint`];
  }
  let total = 0;
  for (const layout of layouts as Layout[]) {
    for (const field of layout.fields ?? []) total += programSize(field.pattern);
    const spec = layout.lineItems;
    if (spec && spec.from !== "attachment") {
      for (const pattern of [spec.pattern, spec.start, spec.end]) {
        if (pattern) total += programSize(pattern);
      }
    }
  }
  return total > MAX_LAYOUTS_PROGRAM
    ? [`the patterns together are too large (${total} steps, at most ${MAX_LAYOUTS_PROGRAM})`]
    : [];
}

export { storedLayouts } from "./stored";

/**
 * The first enabled layout among the first `cap` (layouts past the plan's
 * cap are kept but not used) whose match holds, or null.
 */
export function chooseLayout(
  layouts: readonly Layout[],
  cap: number,
  request: RequestRecord,
  emailFields: Record<string, string | null> | null = null
): Layout | null {
  const subject = ruleSubjectFor(request, emailFields);
  for (const layout of layouts.slice(0, Math.max(cap, 0))) {
    if (layout.enabled === false) continue;
    const conditions = layout.match?.conditions ?? [];
    if (
      conditions.length === 0 ||
      conditionsHold({ logic: layout.match?.logic === "or" ? "or" : "and", conditions }, subject)
    ) {
      return layout;
    }
  }
  return null;
}

export function layoutFieldValues(
  request: RequestRecord,
  layout: Layout
): Record<string, string | null> {
  if (!request.email || !layout.fields?.length) return {};
  return extractEmailFields(
    { email: request.email, headers: request.headers ?? {} },
    layout.fields,
    re2Find
  );
}

function compile(pattern: string | undefined): RE2JS | null {
  if (!pattern) return null;
  try {
    const regex = RE2JS.compile(pattern);
    return regex.programSize() <= MAX_FIELD_PROGRAM * 5 ? regex : null;
  } catch {
    return null;
  }
}

function clip(value: string | null): string | null {
  if (value === null) return null;
  return value.length > MAX_CELL ? value.slice(0, MAX_CELL) : value;
}

/** The text between the start and end markers, when the spec has them. */
function region(text: string, spec: LineItemsSpec): string {
  let out = text.slice(0, MAX_LINE_ITEM_TEXT);
  const start = compile(spec.start);
  if (start) {
    const matcher = start.matcher(out);
    if (!matcher.find()) return "";
    out = out.slice(matcher.end());
  }
  const end = compile(spec.end);
  if (end) {
    const matcher = end.matcher(out);
    if (matcher.find()) out = out.slice(0, matcher.start());
  }
  return out;
}

/** Rows from a pattern with named groups found again and again in the email's text or HTML. */
export function lineItemsFromText(
  request: RequestRecord,
  spec: LineItemsSpec
): Record<string, string | null>[] {
  const email = request.email;
  const regex = compile(spec.pattern);
  if (!email || !regex) return [];
  const source = spec.from === "html" ? htmlToText(email.html ?? "") : (email.text ?? "");
  const text = region(source, spec);
  const names = Object.keys(regex.namedGroups());
  const rows: Record<string, string | null>[] = [];
  const matcher = regex.matcher(text);
  while (rows.length < MAX_LINE_ITEMS && matcher.find()) {
    if (matcher.end() === matcher.start()) {
      // An empty match would find itself forever; nothing to read here.
      break;
    }
    const row: Record<string, string | null> = {};
    if (names.length === 0) row.value = clip(matcher.group(0));
    for (const name of names) row[name] = clip(matcher.group(name) ?? null);
    rows.push(row);
  }
  return rows;
}

/** A file-name wildcard as RE2 (never RegExp: file names come from senders). */
function globToRegex(glob: string): { test: (name: string) => boolean } {
  try {
    const regex = RE2JS.compile(`(?i)${globToRegexSource(glob.slice(0, 200))}`);
    return { test: (name: string) => regex.matcher(name.slice(0, 1000)).find() };
  } catch {
    return { test: () => false };
  }
}

/** Column letters (A, B, ..., AA) as a zero-based index, or null. */
function columnLetterIndex(column: string): number | null {
  if (!/^[A-Za-z]{1,3}$/.test(column)) return null;
  let index = 0;
  for (const ch of column.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Rows from a parsed spreadsheet or CSV: the first row is the header; each
 * further row becomes an item with the mapped columns (or every column by
 * its header).
 */
export function lineItemsFromSheets(
  spec: LineItemsSpec,
  attachments: { parsed: ParsedAttachment; sheets: ParserSheet[] }[]
): Record<string, string | null>[] {
  const pattern = spec.attachment ? globToRegex(spec.attachment) : null;
  const candidate = attachments.find(
    (item) =>
      item.sheets.length > 0 &&
      !item.parsed.error &&
      (!pattern || pattern.test(item.parsed.filename ?? ""))
  );
  if (!candidate) return [];
  const sheet = spec.sheet
    ? candidate.sheets.find((s) => (s.name ?? "").toLowerCase() === spec.sheet!.toLowerCase())
    : candidate.sheets[0];
  if (!sheet || sheet.rows.length === 0) return [];
  const header = sheet.rows[0].map((cell) => cell.trim());
  const columns =
    spec.columns && spec.columns.length > 0
      ? spec.columns.map((column) => {
          const byHeader = header.findIndex(
            (cell) => cell.toLowerCase() === column.column.trim().toLowerCase()
          );
          return {
            name: column.name,
            index: byHeader >= 0 ? byHeader : columnLetterIndex(column.column),
          };
        })
      : header.map((cell, index) => ({ name: cell || `column${index + 1}`, index }));
  return sheet.rows.slice(1, MAX_LINE_ITEMS + 1).map((row) => {
    const item: Record<string, string | null> = {};
    for (const column of columns) {
      item[column.name] = column.index === null ? null : clip(row[column.index] ?? null);
    }
    return item;
  });
}
