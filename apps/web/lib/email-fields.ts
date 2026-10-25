import { createHash } from "node:crypto";
import { RE2JS } from "re2js";
import {
  emailFieldIssues,
  extractEmailFields,
  MAX_EMAIL_FIELD_PATTERN_CHARS,
  type EmailField,
  type EmailFieldFinder,
} from "@webhooks-cc/sdk/email";
import type { RequestRecord } from "@/lib/supabase/requests";

/**
 * An endpoint's named email fields as the web app runs them: the SDK's
 * field list (packages/sdk/src/email/fields.ts) with patterns run by RE2.
 * RE2 takes time linear in the text times the compiled pattern's size, so
 * both are bounded: a field reads at most 64 KB of its part (the SDK), a
 * pattern compiles to at most MAX_FIELD_PROGRAM instructions and a list to
 * MAX_FIELDS_PROGRAM, which keeps one email's fields well under a second
 * however hostile the email or the pattern. The dashboard, the request
 * routes' extracts, forwarding and filters all read them through here.
 */

/** Compiled instructions one pattern may have; ordinary patterns have 10 to 80. */
export const MAX_FIELD_PROGRAM = 200;
/** Compiled instructions a whole field list may have. */
export const MAX_FIELDS_PROGRAM = 600;

const compiled = new Map<string, RE2JS | null>();
const MAX_COMPILED = 256;

function compileUncached(pattern: string): RE2JS | null {
  if (pattern.length > MAX_EMAIL_FIELD_PATTERN_CHARS) return null;
  try {
    const regex = RE2JS.compile(pattern);
    return regex.programSize() <= MAX_FIELD_PROGRAM ? regex : null;
  } catch {
    return null;
  }
}

/** Compiled patterns, at most MAX_COMPILED small ones (a refused one is cached as null). */
function compile(pattern: string): RE2JS | null {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  const regex = compileUncached(pattern);
  if (compiled.size >= MAX_COMPILED) compiled.clear();
  compiled.set(pattern, regex);
  return regex;
}

/** The first group of the first match (or the whole match without a group), or null. */
export const re2Find: EmailFieldFinder = (pattern, text) => {
  const regex = compile(pattern);
  if (!regex) return null;
  const matcher = regex.matcher(text);
  if (!matcher.find()) return null;
  const value = regex.groupCount() >= 1 ? matcher.group(1) : matcher.group(0);
  return value ?? null;
};

/** The compiled size of a pattern RE2 accepts, or null. */
function programSize(pattern: string): number | null {
  try {
    return RE2JS.compile(pattern).programSize();
  } catch {
    return null;
  }
}

/** Why a pattern cannot be a field's, or null; the usual JavaScript habits are named. */
export function fieldPatternProblem(pattern: string): string | null {
  const size = programSize(pattern);
  if (size !== null) {
    return size > MAX_FIELD_PROGRAM
      ? `too large to run quickly on every email (it compiles to ${size} steps, at most ${MAX_FIELD_PROGRAM}): use smaller repeat counts`
      : null;
  }
  if (/\(\?<?[=!]/.test(pattern)) {
    return "lookahead and lookbehind are not supported (RE2): match the text around the value and put the value in a group";
  }
  if (/\\[1-9]/.test(pattern)) return "backreferences are not supported (RE2)";
  try {
    RE2JS.compile(pattern);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^error parsing regexp: /, "");
  }
}

/** What is wrong with a field list, RE2 syntax and size included; empty when it is valid. */
export function emailFieldsProblems(fields: unknown): string[] {
  const problems = emailFieldIssues(fields, fieldPatternProblem);
  if (problems.length > 0 || !Array.isArray(fields)) return problems;
  const total = fields.reduce(
    (sum: number, field: EmailField) => sum + (programSize(field.pattern) ?? 0),
    0
  );
  return total > MAX_FIELDS_PROGRAM
    ? [
        `the patterns together compile to ${total} steps, at most ${MAX_FIELDS_PROGRAM}: use fewer or smaller patterns`,
      ]
    : [];
}

function isFieldShape(field: unknown): field is EmailField {
  return (
    !!field &&
    typeof field === "object" &&
    typeof (field as EmailField).name === "string" &&
    typeof (field as EmailField).from === "string" &&
    typeof (field as EmailField).pattern === "string"
  );
}

/** One field with only its own keys, so nothing else a client sent is stored. */
function normalize(field: EmailField): EmailField {
  return {
    name: field.name,
    from: field.from,
    ...(field.from === "header" && typeof field.header === "string"
      ? { header: field.header }
      : {}),
    pattern: field.pattern,
  };
}

/** A field list as stored: each field with only its own keys. Validate it first. */
export function normalizedEmailFields(fields: readonly EmailField[]): EmailField[] {
  return fields.map(normalize);
}

/** A stored list as fields; anything malformed is left out. */
export function storedEmailFields(value: unknown): EmailField[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isFieldShape).map(normalize);
}

/**
 * Values already found, by request id and field list. A stored email never
 * changes, and SDKs poll lists with extracts, so each email is searched once
 * per field list rather than on every read. The values are copied out of the
 * email's text, which a cached substring would otherwise keep alive.
 */
const found = new Map<string, Record<string, string | null>>();
const MAX_FOUND = 5000;

function cacheKey(requestId: string, fields: readonly EmailField[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(fields.map(normalize)))
    .digest("base64url");
  return `${requestId}:${digest}`;
}

function detached(values: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(values)) {
    out[name] = value === null ? null : Buffer.from(value, "utf8").toString("utf8");
  }
  return out;
}

/**
 * The fields' values for one captured email, or null for an HTTP request or
 * an endpoint with none. `cache: false` for unsaved lists (the preview), so
 * drafts do not fill the cache.
 */
export function emailFieldValues(
  request: Pick<RequestRecord, "id" | "kind" | "email" | "headers">,
  fields: readonly EmailField[],
  options: { cache?: boolean } = {}
): Record<string, string | null> | null {
  if (request.kind !== "email" || !request.email || fields.length === 0) return null;
  const useCache = options.cache !== false;
  const key = useCache ? cacheKey(request.id, fields) : "";
  const cached = useCache ? found.get(key) : undefined;
  if (cached) return { ...cached };
  const values = detached(
    extractEmailFields({ email: request.email, headers: request.headers ?? {} }, fields, re2Find)
  );
  if (useCache) {
    if (found.size >= MAX_FOUND) found.clear();
    found.set(key, values);
  }
  return { ...values };
}
