import { RE2JS } from "re2js";
import { globToRegexSource, layoutIssues } from "@webhooks-cc/sdk";
import {
  extractEmailFields,
  htmlToText,
  MAX_LINE_ITEM_COLUMNS,
  MAX_LINE_ITEMS,
  type Layout,
  type LineItemsSpec,
  type ParsedAttachment,
} from "@webhooks-cc/sdk/email";
import { conditionsHold, globProblem, regexProblem } from "@/lib/rules";
import { fieldPatternProblem, re2Find, MAX_FIELD_PROGRAM } from "@/lib/email-fields";
import { ruleSubjectFor } from "@/lib/request-context";
import type { RequestRecord } from "@/lib/supabase/requests";
import type { ParserSheet } from "./parser";
import { clipText, uniqueNames } from "./fit";

/**
 * Layouts as the server runs them: which one an email matches (the rule
 * language), its fields (RE2, as email fields) and its line items (an RE2
 * pattern with named groups found again and again, or a sheet's rows with a
 * column mapping). Every pattern is RE2 with a bounded program, and every
 * text read is bounded, so a layout cannot stall the parse worker however
 * hostile the email.
 */

/** Text a line-item pattern reads at most (RE2 in JavaScript runs about 1 ms per KB for a long pattern). */
const MAX_LINE_ITEM_TEXT = 64 * 1024;
const MAX_CELL = 1000;
/** A layout list's patterns together (fields, line items, match regexes), in compiled steps. */
const MAX_LAYOUTS_PROGRAM = 20_000;

function programSize(pattern: string): number {
  try {
    return RE2JS.compile(pattern).programSize();
  } catch {
    return 0;
  }
}

/**
 * What is wrong with a layout list, RE2 syntax and size included; empty when
 * valid. A list may be longer than the plan's cap: layouts past it are kept
 * but not matched (chooseLayout), so a downgrade never blocks editing.
 */
export function layoutsProblems(layouts: unknown): string[] {
  const problems = layoutIssues(layouts, fieldPatternProblem, {
    checkRegex: regexProblem,
    checkGlob: globProblem,
  });
  if (problems.length > 0 || !Array.isArray(layouts)) return problems;
  let total = 0;
  for (const layout of layouts as Layout[]) {
    for (const condition of layout.match?.conditions ?? []) {
      if (condition.op === "regex" && typeof condition.value === "string") {
        total += programSize(condition.value);
      }
    }
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
  emailFields: Record<string, string | null> | null = null,
  deadline = Number.POSITIVE_INFINITY
): Layout | null {
  const subject = ruleSubjectFor(request, emailFields);
  for (const layout of layouts.slice(0, Math.max(cap, 0))) {
    // Out of time: no layout rather than a stalled worker.
    if (Date.now() > deadline) return null;
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
  return value === null ? null : clipText(value, MAX_CELL);
}

/** The text between the start and end markers, when the spec has them. */
function region(text: string, spec: LineItemsSpec): string {
  // Cut on a code point: a capture running to the cut must not end in half an emoji.
  let out = clipText(text, MAX_LINE_ITEM_TEXT);
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

/** Line items and their columns in order (stored JSON objects do not keep key order). */
export interface LineItems {
  rows: Record<string, string | null>[];
  columns: string[];
  /** The scan stopped at its time or find limit. */
  truncated?: boolean;
}

/** A sheet's columns kept without a mapping, and a column name's length. */
const MAX_SHEET_COLUMNS = MAX_LINE_ITEM_COLUMNS;
const MAX_COLUMN_NAME = 100;

/** Line items read from text stop after this long; the regex runs on the server's main thread. */
export const LINE_ITEMS_BUDGET_MS = 2_000;
/** Finds of a line-item pattern per email, empty ones included. */
const MAX_FINDS = MAX_LINE_ITEMS * 4;

/**
 * Rows from a pattern with named groups found again and again in the email's
 * text or HTML. Bounded in time (`deadline`) and in finds, so no pattern can
 * hold the server; a scan cut short says so (`truncated`).
 */
export function lineItemsFromText(
  request: RequestRecord,
  spec: LineItemsSpec,
  deadline = Date.now() + LINE_ITEMS_BUDGET_MS
): LineItems {
  const email = request.email;
  const regex = compile(spec.pattern);
  if (!email || !regex) return { rows: [], columns: [] };
  const source = spec.from === "html" ? htmlToText(email.html ?? "") : (email.text ?? "");
  const text = region(source, spec);
  const groups = regex.namedGroups() as Record<string, number>;
  const names = Object.keys(groups).sort((a, b) => groups[a] - groups[b]);
  const rows: Record<string, string | null>[] = [];
  const matcher = regex.matcher(text);
  let finds = 0;
  let truncated = false;
  while (rows.length < MAX_LINE_ITEMS) {
    if (finds++ >= MAX_FINDS || Date.now() > deadline) {
      truncated = true;
      break;
    }
    if (!matcher.find()) break;
    // An empty match is skipped; the matcher moves on past it.
    if (matcher.end() === matcher.start()) continue;
    // Entries, not assignment: a group named __proto__ stays a column.
    rows.push(
      Object.fromEntries(
        names.length === 0
          ? [["value", clip(matcher.group(0))]]
          : names.map((name) => [name, clip(matcher.group(name) ?? null)])
      )
    );
  }
  return {
    rows,
    columns: names.length === 0 ? ["value"] : names,
    ...(truncated ? { truncated: true } : {}),
  };
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

/** Whether a file name matches a line-item spec's `attachment` wildcard (any file when it has none). */
export function attachmentMatcher(glob: string | undefined): (name: string) => boolean {
  if (!glob) return () => true;
  const regex = globToRegex(glob);
  return (name) => regex.test(name);
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
): LineItems {
  const pattern = spec.attachment ? globToRegex(spec.attachment) : null;
  const usable = attachments.filter(
    (item) =>
      item.sheets.length > 0 &&
      !item.parsed.error &&
      (!pattern || pattern.test(item.parsed.filename ?? ""))
  );
  // The first with rows past its header, as the worker parses until it finds one.
  const candidate =
    usable.find((item) => item.sheets.some((sheet) => sheet.rows.length > 1)) ?? usable[0];
  if (!candidate) return { rows: [], columns: [] };
  const sheet = spec.sheet
    ? candidate.sheets.find((s) => (s.name ?? "").toLowerCase() === spec.sheet!.toLowerCase())
    : candidate.sheets[0];
  if (!sheet || sheet.rows.length === 0) return { rows: [], columns: [] };
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
      : // Every column by its header, as many as a mapping may have, with
        // short and distinct names: the header is the sender's.
        uniqueNames(
          header.slice(0, MAX_SHEET_COLUMNS).map((cell, index) => cell || `column${index + 1}`),
          MAX_COLUMN_NAME
        ).map((name, index) => ({ name, index }));
  // Entries, not assignment: a header named __proto__ stays a column.
  const rows = sheet.rows
    .slice(1, MAX_LINE_ITEMS + 1)
    .map((row) =>
      Object.fromEntries(
        columns.map((column) => [
          column.name,
          column.index === null ? null : clip(row[column.index] ?? null),
        ])
      )
    );
  return { rows, columns: [...new Set(columns.map((column) => column.name))] };
}
