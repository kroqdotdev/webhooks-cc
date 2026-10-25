/**
 * Templates: `{{ path }}` placeholders filled in from a captured request.
 * Mock responses are filled in by the receiver in Rust
 * (apps/receiver-rs/src/handlers/placeholders.rs); forwarded payloads and chat
 * messages by the web app with this module. Both read the same vectors
 * (conformance/placeholders.json, written by the conformance test); change them
 * together.
 *
 * A placeholder is a dot path into the template context, optionally followed
 * by filters: `{{ json.order.id }}`, `{{ headers.user-agent | lower }}`,
 * `{{ json.note | default: "none" }}`. There are no loops and no conditions:
 * which response or destination applies is decided by rules, and a template
 * only fills in values, so rendering always finishes.
 *
 * A placeholder whose first key is not part of the context (`{{ name }}` in
 * a body written for another template engine) stays as written, so bodies
 * saved before templates existed are sent unchanged. So does anything
 * between `{{` and `}}` that is not a valid placeholder.
 */

import { formatNumber, parsePath, valueToText, walkPath, parseStructuredBody } from "./rules";

/** The filters a placeholder can use, in the order they are applied. */
export type TemplateFilter =
  | { name: "default"; arg: string }
  | { name: "json" }
  | { name: "lower" }
  | { name: "upper" }
  | { name: "truncate"; arg: number };

export interface Placeholder {
  /** The keys of the path. */
  keys: string[];
  filters: TemplateFilter[];
}

/** One piece of a parsed template. */
export type TemplatePart =
  | { type: "text"; text: string }
  | { type: "placeholder"; placeholder: Placeholder; source: string };

/**
 * How filled-in values are written:
 * - `text` as they are;
 * - `json` for a JSON body: strings escaped for a JSON string (the template
 *   supplies the quotes), other values as JSON;
 * - `html` HTML-escaped.
 */
export type TemplateMode = "text" | "json" | "html";

export interface RenderOptions {
  mode?: TemplateMode;
  /** The value of `uuid`; one per render. Generated when left out. */
  uuid?: string;
  /** The value of `now` (ISO 8601). The current time when left out. */
  now?: string;
  /** Stop once the output reaches this many bytes (UTF-8). */
  maxBytes?: number;
}

/** Context keys that are generated per render rather than read from the request. */
const GENERATED_ROOTS = ["uuid", "now"] as const;

/** Keys of the context for an HTTP request in the receiver (mock responses). */
export const RESPONSE_TEMPLATE_ROOTS = [
  "id",
  "kind",
  "method",
  "path",
  "query",
  "headers",
  "body",
  "json",
  "contentType",
  "ip",
  "size",
  "receivedAt",
  "endpoint",
  ...GENERATED_ROOTS,
] as const;

/** Keys of the context for an HTTP request when it is forwarded. */
export const REQUEST_TEMPLATE_ROOTS = [...RESPONSE_TEMPLATE_ROOTS, "signature"] as const;

/** Keys of the context for an email when it is forwarded. */
export const EMAIL_TEMPLATE_ROOTS = [
  "id",
  "kind",
  "endpoint",
  "receivedAt",
  "address",
  "tag",
  "subject",
  "from",
  "to",
  "cc",
  "replyTo",
  "date",
  "messageId",
  "inReplyTo",
  "text",
  "html",
  "replyText",
  "fields",
  "codes",
  "links",
  "attachments",
  "auth",
  "spam",
  "headers",
  "size",
  "truncated",
  "test",
  "signature",
  ...GENERATED_ROOTS,
] as const;

const FILTER_NAMES = new Set(["default", "json", "lower", "upper", "truncate"]);

/** Spaces inside `{{ }}`: ASCII only, so the receiver reads placeholders the same way. */
function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parses what is between `{{` and `}}`; null when it is not a placeholder. */
export function parsePlaceholder(inner: string): Placeholder | null {
  let i = 0;
  const skipSpace = () => {
    while (i < inner.length && isSpace(inner[i])) i++;
  };
  skipSpace();
  const pathStart = i;
  // The path runs to whitespace or `|`, except inside brackets.
  let inBracket = false;
  let inString = false;
  while (i < inner.length) {
    const ch = inner[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (inBracket) {
      if (ch === '"') inString = true;
      else if (ch === "]") inBracket = false;
    } else if (ch === "[") {
      inBracket = true;
    } else if (isSpace(ch) || ch === "|") {
      break;
    }
    i++;
  }
  const pathText = inner.slice(pathStart, i);
  if (pathText === "" || pathText.startsWith(".") || pathText.startsWith("[")) return null;
  const keys = parsePath(pathText, true);
  if (!keys || keys.length === 0) return null;

  const filters: TemplateFilter[] = [];
  skipSpace();
  while (i < inner.length) {
    if (inner[i] !== "|") return null;
    i++;
    skipSpace();
    const nameStart = i;
    while (i < inner.length && /[a-z]/.test(inner[i])) i++;
    const name = inner.slice(nameStart, i);
    if (!FILTER_NAMES.has(name)) return null;
    skipSpace();
    let arg: string | number | undefined;
    if (inner[i] === ":") {
      i++;
      skipSpace();
      if (inner[i] === '"') {
        i++;
        let text = "";
        let closed = false;
        while (i < inner.length) {
          const ch = inner[i];
          if (ch === "\\") {
            const next = inner[i + 1];
            if (next !== '"' && next !== "\\") return null;
            text += next;
            i += 2;
            continue;
          }
          if (ch === '"') {
            closed = true;
            i++;
            break;
          }
          text += ch;
          i++;
        }
        if (!closed) return null;
        arg = text;
      } else {
        const digitsStart = i;
        while (i < inner.length && /[0-9]/.test(inner[i])) i++;
        if (i === digitsStart) return null;
        arg = Number(inner.slice(digitsStart, i));
      }
      skipSpace();
    }
    switch (name) {
      case "default":
        if (arg === undefined) return null;
        filters.push({ name: "default", arg: String(arg) });
        break;
      case "truncate":
        if (typeof arg !== "number" || arg < 1 || arg > 1_000_000) return null;
        filters.push({ name: "truncate", arg });
        break;
      default:
        if (arg !== undefined) return null;
        filters.push({ name: name as "json" | "lower" | "upper" });
    }
  }
  return { keys, filters };
}

/**
 * Splits a template into text and placeholders. A `{{` that does not open a
 * valid placeholder is text, and scanning goes on at the next character.
 */
export function parseTemplate(source: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = "";
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{{", i);
    if (open === -1) {
      text += source.slice(i);
      break;
    }
    text += source.slice(i, open);
    const close = source.indexOf("}}", open + 2);
    const placeholder = close === -1 ? null : parsePlaceholder(source.slice(open + 2, close));
    if (!placeholder) {
      text += source[open];
      i = open + 1;
      continue;
    }
    if (text) parts.push({ type: "text", text });
    text = "";
    parts.push({ type: "placeholder", placeholder, source: source.slice(open, close + 2) });
    i = close + 2;
  }
  if (text) parts.push({ type: "text", text });
  return parts;
}

/** Whether a string holds at least one placeholder (known roots or not). */
export function hasPlaceholders(source: string): boolean {
  return parseTemplate(source).some((part) => part.type === "placeholder");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The context a template reads, with the generated values for this render. */
type Context = Record<string, unknown>;

/** A value after filters; `raw` when the last filter was json (already JSON text). */
interface Filled {
  value: unknown;
  raw: boolean;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

function lookup(context: Context, keys: readonly string[]): unknown {
  // Header names match in any case: the key after `headers` is lowercased,
  // and the context's header names are lowercase.
  const adjusted =
    keys[0] === "headers" && keys.length > 1
      ? [keys[0], keys[1].toLowerCase(), ...keys.slice(2)]
      : keys;
  return walkPath(context, adjusted);
}

function fill(placeholder: Placeholder, context: Context): Filled {
  let value = lookup(context, placeholder.keys);
  let raw = false;
  for (const filter of placeholder.filters) {
    raw = false;
    switch (filter.name) {
      case "default":
        if (value === undefined || value === null || value === "") value = filter.arg;
        break;
      case "json":
        value = JSON.stringify(value === undefined ? null : value);
        raw = true;
        break;
      case "lower":
        value = valueToText(value).toLowerCase();
        break;
      case "upper":
        value = valueToText(value).toUpperCase();
        break;
      case "truncate":
        value = truncate(valueToText(value), filter.arg);
        break;
    }
  }
  return { value, raw };
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonEscape(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** How a filled-in value is written in each mode. */
function write(filled: Filled, mode: TemplateMode): string {
  const { value, raw } = filled;
  if (raw) return mode === "html" ? htmlEscape(value as string) : (value as string);
  if (mode === "json") {
    if (value === undefined) return "";
    if (typeof value === "string") return jsonEscape(value);
    if (value === null) return "null";
    if (typeof value === "number") return formatNumber(value);
    return JSON.stringify(value);
  }
  const text = valueToText(value);
  return mode === "html" ? htmlEscape(text) : text;
}

function withGenerated(context: Context, options: RenderOptions): Context {
  return {
    ...context,
    uuid: options.uuid ?? globalThis.crypto.randomUUID(),
    now: options.now ?? new Date().toISOString(),
  };
}

/** Whether a placeholder's first key is in the context (its path may still lead nowhere). */
function known(placeholder: Placeholder, context: Context): boolean {
  return Object.prototype.hasOwnProperty.call(context, placeholder.keys[0]);
}

const encoder = new TextEncoder();

/** Appends `piece` unless the output would pass maxBytes; cut at a character. */
class Output {
  text = "";
  bytes = 0;
  full = false;
  constructor(private readonly maxBytes: number) {}
  push(piece: string) {
    if (this.full || piece === "") return;
    const size = encoder.encode(piece).length;
    if (this.bytes + size <= this.maxBytes) {
      this.text += piece;
      this.bytes += size;
      return;
    }
    for (const ch of piece) {
      const n = encoder.encode(ch).length;
      if (this.bytes + n > this.maxBytes) break;
      this.text += ch;
      this.bytes += n;
    }
    this.full = true;
  }
}

function renderParts(
  parts: TemplatePart[],
  context: Context,
  mode: TemplateMode,
  maxBytes: number
): string {
  const out = new Output(maxBytes);
  for (const part of parts) {
    if (part.type === "text") out.push(part.text);
    else if (!known(part.placeholder, context)) out.push(part.source);
    else out.push(write(fill(part.placeholder, context), mode));
    if (out.full) break;
  }
  return out.text;
}

/** A template whose output would pass the size it may take. */
export class TemplateTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The template's output is larger than ${maxBytes} bytes.`);
    this.name = "TemplateTooLargeError";
  }
}

/** Fills in a template string. */
export function renderTemplate(
  source: string,
  context: Record<string, unknown>,
  options: RenderOptions = {}
): string {
  if (!source.includes("{{")) return source;
  return renderParts(
    parseTemplate(source),
    withGenerated(context, options),
    options.mode ?? "text",
    options.maxBytes ?? Number.MAX_SAFE_INTEGER
  );
}

/**
 * Fills in a JSON document whose string values hold placeholders. A string
 * that is exactly one placeholder takes the value's own type (an object, a
 * number, null when the path leads nowhere); any other string is filled in
 * as text. Keys are left alone.
 */
export function renderJsonTemplate(
  template: unknown,
  context: Record<string, unknown>,
  options: Omit<RenderOptions, "mode"> = {}
): unknown {
  const ctx = withGenerated(context, options);
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  // Each filled-in value counts against maxBytes, so a template that repeats
  // a large value cannot build an unbounded document.
  let budget = maxBytes;
  const spend = (value: unknown) => {
    const text = typeof value === "string" ? value : (JSON.stringify(value ?? null) ?? "");
    budget -= text.length;
    if (budget < 0) throw new TemplateTooLargeError(maxBytes);
  };
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (!node.includes("{{")) return node;
      const parts = parseTemplate(node);
      if (parts.length === 1 && parts[0].type === "placeholder") {
        const { placeholder, source } = parts[0];
        if (!known(placeholder, ctx)) return source;
        const filled = fill(placeholder, ctx);
        const value = filled.value === undefined ? null : filled.value;
        spend(value);
        return value;
      }
      const out = new Output(budget);
      for (const part of parts) {
        if (part.type === "text") out.push(part.text);
        else if (!known(part.placeholder, ctx)) out.push(part.source);
        else out.push(write(fill(part.placeholder, ctx), "text"));
        if (out.full) throw new TemplateTooLargeError(maxBytes);
      }
      spend(out.text);
      return out.text;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) out[key] = visit(value);
      return out;
    }
    return node;
  };
  return visit(template);
}

/**
 * The mode for a mock response body: json when the Content-Type says JSON
 * (or, without one, when the body starts with `{` or `[`), html for HTML and
 * XML, text otherwise.
 */
export function responseTemplateMode(
  body: string,
  headers: Record<string, string> | undefined
): TemplateMode {
  let contentType: string | undefined;
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "content-type") contentType = value.toLowerCase();
  }
  if (contentType !== undefined) {
    if (contentType.includes("json")) return "json";
    if (contentType.includes("html") || contentType.includes("xml")) return "html";
    return "text";
  }
  const start = body.trimStart()[0];
  return start === "{" || start === "[" ? "json" : "text";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Placeholders a template uses that cannot be filled in: an unknown first
 * key (a typo, or a key this kind of request does not have). Returned as
 * written, for a message such as "{{ subjct }} is not a field".
 */
export function unknownPlaceholders(source: string, roots: readonly string[]): string[] {
  const allowed = new Set(roots);
  const unknown: string[] = [];
  for (const part of parseTemplate(source)) {
    if (part.type === "placeholder" && !allowed.has(part.placeholder.keys[0])) {
      unknown.push(part.source);
    }
  }
  return unknown;
}

/** unknownPlaceholders for every string in a JSON template. */
export function unknownJsonPlaceholders(template: unknown, roots: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === "string") found.push(...unknownPlaceholders(node, roots));
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === "object") Object.values(node).forEach(visit);
  };
  visit(template);
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/** What an HTTP request's context is built from. */
export interface TemplateRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Query parameters (one value per name). */
  query: Record<string, string>;
  /** The body as text; null or "" when there is none. */
  body: string | null;
  contentType: string | null;
  ip: string;
  size: number;
  /** Milliseconds since the epoch, or an ISO 8601 string. */
  receivedAt: number | string;
  endpoint: { slug: string; name: string | null };
}

function isoTime(value: number | string): string {
  return typeof value === "number" ? new Date(value).toISOString() : value;
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/**
 * The context for an HTTP request: what `{{ ... }}` can read in a mock
 * response or a forwarded payload. `json` is the body parsed as JSON, or its
 * fields when it is a form; it is left out when the body is neither.
 */
export function requestTemplateContext(
  request: TemplateRequest,
  extra: { signature?: string | null } = {}
): Record<string, unknown> {
  const body = request.body ?? "";
  return {
    id: request.id,
    kind: "http",
    method: request.method,
    path: request.path,
    query: request.query,
    headers: lowercaseKeys(request.headers),
    body,
    // Present even when the body is neither JSON nor a form, so
    // `{{ json.id }}` is empty rather than left as written.
    json: parseStructuredBody(body, request.contentType),
    contentType: request.contentType,
    ip: request.ip,
    size: request.size,
    receivedAt: isoTime(request.receivedAt),
    endpoint: { slug: request.endpoint.slug, name: request.endpoint.name },
    ...("signature" in extra ? { signature: extra.signature ?? "missing" } : {}),
  };
}

/**
 * The context for an email: the `data` of its `email.received` JSON (what
 * the dashboard's JSON tab shows), plus `kind`, with header names in
 * lowercase.
 */
export function emailTemplateContext(
  data: Record<string, unknown>,
  extra: { signature?: string | null } = {}
): Record<string, unknown> {
  const headers =
    data.headers && typeof data.headers === "object"
      ? lowercaseKeys(data.headers as Record<string, string>)
      : {};
  const context: Record<string, unknown> = {};
  // Every key is present (codes and links are left out of the JSON when the
  // endpoint does not show them), so a placeholder for one is empty, not
  // left as written.
  for (const root of EMAIL_TEMPLATE_ROOTS) context[root] = undefined;
  Object.assign(context, data, { kind: "email", headers });
  if ("signature" in extra) context.signature = extra.signature ?? "missing";
  else delete context.signature;
  for (const root of GENERATED_ROOTS) delete context[root];
  return context;
}
