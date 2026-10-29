import { conditionsIssues } from "./rules";
import { emailFieldIssues } from "./email/fields";
import {
  MAX_LAYOUTS,
  MAX_LAYOUT_NAME_CHARS,
  MAX_LINE_ITEM_COLUMNS,
  MAX_LINE_ITEM_PATTERN_CHARS,
} from "./email/layouts";

/** Checks an endpoint's layouts (src/email/layouts.ts) as the API does, short of RE2 syntax. */

const LAYOUT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * What a layout list says is wrong with it; empty when it is valid. Pass
 * `checkPattern` to check RE2 syntax (the server does).
 */
export function layoutIssues(
  layouts: unknown,
  checkPattern?: (pattern: string) => string | null
): string[] {
  if (!Array.isArray(layouts)) return ["layouts must be a list"];
  if (layouts.length > MAX_LAYOUTS) return [`at most ${MAX_LAYOUTS} layouts`];
  const issues: string[] = [];
  const ids = new Set<string>();
  layouts.forEach((value: unknown, index) => {
    const at = `layout ${index + 1}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`${at}: must be an object`);
      return;
    }
    const layout = value as Record<string, unknown>;
    if (typeof layout.id !== "string" || !LAYOUT_ID.test(layout.id)) {
      issues.push(`${at}: id must be 1 to 40 letters, digits, - or _`);
    } else if (ids.has(layout.id)) {
      issues.push(`${at}: the id "${layout.id}" is used twice`);
    } else ids.add(layout.id);
    if (
      typeof layout.name !== "string" ||
      !layout.name.trim() ||
      layout.name.length > MAX_LAYOUT_NAME_CHARS
    ) {
      issues.push(`${at}: name is 1 to ${MAX_LAYOUT_NAME_CHARS} characters`);
    }
    if (layout.enabled !== undefined && typeof layout.enabled !== "boolean") {
      issues.push(`${at}: enabled must be true or false`);
    }
    if (layout.parseAttachments !== undefined && typeof layout.parseAttachments !== "boolean") {
      issues.push(`${at}: parseAttachments must be true or false`);
    }
    if (layout.match !== undefined && layout.match !== null) {
      const match = layout.match as { logic?: unknown; conditions?: unknown };
      if (typeof match !== "object" || Array.isArray(match)) {
        issues.push(`${at}: match must be { logic, conditions }`);
      } else {
        if (match.logic !== undefined && match.logic !== "and" && match.logic !== "or") {
          issues.push(`${at}: match.logic must be "and" or "or"`);
        }
        for (const issue of conditionsIssues(
          match.conditions,
          { use: "filter" },
          `${at}: match.conditions`
        )) {
          issues.push(issue);
        }
      }
    }
    if (layout.fields !== undefined) {
      for (const issue of emailFieldIssues(layout.fields, checkPattern)) {
        issues.push(`${at}: ${issue}`);
      }
    }
    if (layout.lineItems !== undefined && layout.lineItems !== null) {
      issues.push(...lineItemIssues(layout.lineItems, at, checkPattern));
    }
  });
  return issues;
}

function lineItemIssues(
  value: unknown,
  at: string,
  checkPattern?: (pattern: string) => string | null
): string[] {
  if (typeof value !== "object" || Array.isArray(value))
    return [`${at}: lineItems must be an object`];
  const spec = value as Record<string, unknown>;
  const issues: string[] = [];
  if (spec.from !== "text" && spec.from !== "html" && spec.from !== "attachment") {
    return [`${at}: lineItems.from is "text", "html" or "attachment"`];
  }
  const pattern = (key: "pattern" | "start" | "end", required: boolean) => {
    const p = spec[key];
    if (p === undefined || p === null || p === "") {
      if (required) issues.push(`${at}: lineItems.${key} is required`);
      return;
    }
    if (typeof p !== "string" || p.length > MAX_LINE_ITEM_PATTERN_CHARS) {
      issues.push(
        `${at}: lineItems.${key} is a pattern of at most ${MAX_LINE_ITEM_PATTERN_CHARS} characters`
      );
      return;
    }
    const problem = checkPattern?.(p);
    if (problem) issues.push(`${at}: lineItems.${key}: ${problem}`);
  };
  if (spec.from === "attachment") {
    if (
      spec.attachment !== undefined &&
      (typeof spec.attachment !== "string" || spec.attachment.length > 200)
    ) {
      issues.push(`${at}: lineItems.attachment is a file name pattern`);
    }
    if (spec.sheet !== undefined && (typeof spec.sheet !== "string" || spec.sheet.length > 100)) {
      issues.push(`${at}: lineItems.sheet is a sheet name`);
    }
    if (spec.columns !== undefined) {
      if (!Array.isArray(spec.columns) || spec.columns.length > MAX_LINE_ITEM_COLUMNS) {
        issues.push(`${at}: lineItems.columns is a list of at most ${MAX_LINE_ITEM_COLUMNS}`);
      } else {
        for (const column of spec.columns as unknown[]) {
          const c = column as { name?: unknown; column?: unknown } | null;
          if (!c || typeof c.name !== "string" || !COLUMN_NAME.test(c.name)) {
            issues.push(`${at}: each lineItems column needs a name of letters, digits and _`);
          } else if (typeof c.column !== "string" || !c.column.trim() || c.column.length > 200) {
            issues.push(`${at}: lineItems column ${c.name} needs a header or column letter`);
          }
        }
      }
    }
  } else {
    pattern("pattern", true);
    pattern("start", false);
    pattern("end", false);
  }
  return issues;
}
