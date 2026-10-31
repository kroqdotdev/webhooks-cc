import { htmlToText } from "./extract";
import type { EmailAddress, EmailCapture } from "./types";

/**
 * Named fields an endpoint picks out of every email it captures: a name, the
 * part of the email to read, and a regular expression whose first group (or
 * whole match) is the value. They appear as `fields` in the email JSON,
 * where forwarding templates and filters read them (`{{ fields.invoice }}`).
 *
 * Patterns are RE2 syntax and are run by the caller's `find`: webhooks.cc
 * runs them with RE2, which takes time linear in the email whatever the
 * pattern. Nothing here builds a RegExp from a pattern.
 */

/** The part of an email a field reads. */

/** The first `max` UTF-16 units, one fewer rather than half a surrogate pair. */
function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

export type EmailFieldSource = "subject" | "text" | "html" | "from" | "to" | "header";

export const EMAIL_FIELD_SOURCES: readonly EmailFieldSource[] = [
  "subject",
  "text",
  "html",
  "from",
  "to",
  "header",
];

export interface EmailField {
  /** How templates and filters refer to it: letters, digits and _, starting with a letter. */
  name: string;
  /** What it reads; "html" is the HTML as text, "header" needs `header`. */
  from: EmailFieldSource;
  /** The header's name, for `from: "header"`. */
  header?: string;
  /** RE2 syntax; the first group is the value, or the whole match without one. */
  pattern: string;
}

export const MAX_EMAIL_FIELDS = 20;
export const MAX_EMAIL_FIELD_PATTERN_CHARS = 300;
/** A value longer than this is cut. */
export const MAX_EMAIL_FIELD_VALUE_CHARS = 1000;
/**
 * How much of its part a field reads. RE2 takes time linear in the text and
 * in the compiled pattern, so both are bounded (the server also caps the
 * pattern's compiled size).
 */
export const MAX_EMAIL_FIELD_TEXT_CHARS = 65_536;

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

/**
 * Finds `pattern` in `text`: the first capture group's text (or the whole
 * match when the pattern has no group), or null when it does not match.
 */
export type EmailFieldFinder = (pattern: string, text: string) => string | null;

/** What a field list says is wrong with it; empty when it is valid. Pass `checkPattern` to check RE2 syntax too. */
export function emailFieldIssues(
  fields: unknown,
  checkPattern?: (pattern: string) => string | null
): string[] {
  if (!Array.isArray(fields)) return ["emailFields must be a list"];
  if (fields.length > MAX_EMAIL_FIELDS) return [`at most ${MAX_EMAIL_FIELDS} fields`];
  const issues: string[] = [];
  const names = new Set<string>();
  fields.forEach((field: unknown, index) => {
    const at = `field ${index + 1}`;
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      issues.push(`${at}: must be an object`);
      return;
    }
    const f = field as Record<string, unknown>;
    if (typeof f.name !== "string" || !FIELD_NAME.test(f.name)) {
      issues.push(
        `${at}: name must be letters, digits and _, start with a letter, at most 40 characters`
      );
    } else if (names.has(f.name)) {
      issues.push(`${at}: the name "${f.name}" is used twice`);
    } else {
      names.add(f.name);
    }
    if (typeof f.from !== "string" || !EMAIL_FIELD_SOURCES.includes(f.from as EmailFieldSource)) {
      issues.push(`${at}: from must be one of ${EMAIL_FIELD_SOURCES.join(", ")}`);
    } else if (f.from === "header") {
      if (typeof f.header !== "string" || !HEADER_NAME.test(f.header)) {
        issues.push(`${at}: header must be a header name`);
      }
    } else if (f.header !== undefined && f.header !== null) {
      issues.push(`${at}: header is only for from "header"`);
    }
    if (typeof f.pattern !== "string" || f.pattern.length === 0) {
      issues.push(`${at}: pattern is required`);
    } else if (f.pattern.length > MAX_EMAIL_FIELD_PATTERN_CHARS) {
      issues.push(`${at}: pattern is longer than ${MAX_EMAIL_FIELD_PATTERN_CHARS} characters`);
    } else if (checkPattern) {
      const problem = checkPattern(f.pattern);
      if (problem) issues.push(`${at}: pattern: ${problem}`);
    }
  });
  return issues;
}

/** What fields read from a captured email. */
export interface EmailFieldSourceData {
  email: Pick<EmailCapture, "subject" | "text" | "html" | "from" | "to" | "cc">;
  /** Header names in lower case. */
  headers: Record<string, string>;
}

function addressText(address: EmailAddress): string {
  if (!address.address) return address.name ?? "";
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

function sourceText(source: EmailFieldSourceData, field: EmailField): string {
  return clipChars(wholeSourceText(source, field), MAX_EMAIL_FIELD_TEXT_CHARS);
}

function wholeSourceText(source: EmailFieldSourceData, field: EmailField): string {
  const { email } = source;
  switch (field.from) {
    case "subject":
      return email.subject ?? "";
    case "text":
      return email.text ?? (email.html ? htmlToText(email.html) : "");
    case "html":
      return email.html ? htmlToText(email.html) : (email.text ?? "");
    case "from":
      return email.from.map(addressText).join(", ");
    case "to":
      return [...email.to, ...email.cc].map(addressText).join(", ");
    case "header": {
      // Own keys only: a header named "constructor" must not read Object.prototype.
      const name = (field.header ?? "").toLowerCase();
      const value = Object.prototype.hasOwnProperty.call(source.headers, name)
        ? source.headers[name]
        : undefined;
      return typeof value === "string" ? value : "";
    }
  }
}

/**
 * The value of each field for one email, by name: what `find` returned,
 * trimmed and cut at 1,000 characters, or null when the pattern did not
 * match (or the part is empty). Each field reads the first 64 KB of its part.
 */
export function extractEmailFields(
  source: EmailFieldSourceData,
  fields: readonly EmailField[],
  find: EmailFieldFinder
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const texts = new Map<string, string>();
  for (const field of fields.slice(0, MAX_EMAIL_FIELDS)) {
    const key = field.from === "header" ? `header:${field.header ?? ""}` : field.from;
    let text = texts.get(key);
    if (text === undefined) {
      text = sourceText(source, field);
      texts.set(key, text);
    }
    const found = text ? find(field.pattern, text) : null;
    const value = found === null ? null : clipChars(found.trim(), MAX_EMAIL_FIELD_VALUE_CHARS);
    out[field.name] = value === "" ? null : value;
  }
  return out;
}
