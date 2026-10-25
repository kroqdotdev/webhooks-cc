/**
 * Conditions: the one rule language behind response rules (which response a
 * sender gets) and forwarding filters (which captured requests a destination
 * receives). The receiver evaluates response rules in Rust
 * (apps/receiver-rs/src/handlers/rules.rs) and the forwarding worker
 * evaluates filters with this module, so both read the same vectors
 * (conformance/rules.json, written by the conformance test); change them
 * together.
 *
 * A condition reads one field of the request (`field`, plus `name` for a
 * header, query parameter or email part and `path` for a body field) and
 * compares it with `value` using `op`. Response rules see the HTTP request;
 * filters also see the kind, the email and the signature check.
 */

/** Fields a condition can read. */
export type ConditionField =
  | "method"
  | "path"
  | "header"
  | "query"
  | "body"
  | "body_contains"
  | "body_path"
  | "content_type"
  | "size"
  | "kind"
  | "email"
  | "email_field"
  | "spam_score"
  | "email_auth"
  | "signature";

/** How a condition compares. */
export type ConditionOp =
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "matches"
  | "regex"
  | "exists"
  | "not_exists"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

/** Every operator, in a stable order (for schemas and pickers). */
export const CONDITION_OPS = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "matches",
  "regex",
  "exists",
  "not_exists",
  "gt",
  "gte",
  "lt",
  "lte",
] as const satisfies readonly ConditionOp[];

/** The parts of an email a condition can read with `field: "email"`. */
export type EmailConditionPart = "subject" | "from" | "to" | "text" | "tag";

/** One condition. */
export interface Condition {
  field: ConditionField;
  op: ConditionOp;
  /** What to compare with. Not used by exists and not_exists. */
  value?: string;
  /** Header or query parameter name; the email part; spf, dkim or dmarc. */
  name?: string;
  /** Dot path into the JSON (or form) body, for body_path. */
  path?: string;
}

/** Conditions and how they combine. */
export interface ConditionGroup {
  /** "and" (every condition) or "or" (any). Default "and". */
  logic?: "and" | "or";
  conditions: Condition[];
}

/** Where a condition is used: what the sender gets back, or what a destination receives. */
export type ConditionUse = "response" | "filter";

const STRING_OPS: ConditionOp[] = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "matches",
  "regex",
];
const PRESENCE_OPS: ConditionOp[] = ["exists", "not_exists"];
const NUMBER_OPS: ConditionOp[] = ["gt", "gte", "lt", "lte"];

interface FieldSpec {
  ops: ConditionOp[];
  /** Which key the field needs. */
  key?: "name" | "path";
  /** Allowed values of `name`, when fixed. */
  names?: readonly string[];
  /** Response rules can use it (the receiver knows it before answering). */
  response: boolean;
}

/** Every field, the operators it takes and where it can be used. */
export const CONDITION_FIELDS: Record<ConditionField, FieldSpec> = {
  method: { ops: ["eq", "neq"], response: true },
  path: { ops: STRING_OPS, response: true },
  header: { ops: [...PRESENCE_OPS, ...STRING_OPS, ...NUMBER_OPS], key: "name", response: true },
  query: { ops: [...PRESENCE_OPS, ...STRING_OPS, ...NUMBER_OPS], key: "name", response: true },
  body: { ops: ["contains", "not_contains", "regex"], response: true },
  body_contains: { ops: ["contains"], response: true },
  body_path: {
    ops: [...PRESENCE_OPS, ...STRING_OPS, ...NUMBER_OPS],
    key: "path",
    response: true,
  },
  content_type: {
    ops: ["eq", "neq", "contains", "not_contains", "starts_with", "regex"],
    response: true,
  },
  size: { ops: ["eq", "neq", ...NUMBER_OPS], response: true },
  kind: { ops: ["eq", "neq"], response: false },
  email: {
    ops: [...PRESENCE_OPS, ...STRING_OPS],
    key: "name",
    names: ["subject", "from", "to", "text", "tag"],
    response: false,
  },
  // One of the endpoint's named email fields, by name.
  email_field: {
    ops: [...PRESENCE_OPS, ...STRING_OPS, ...NUMBER_OPS],
    key: "name",
    response: false,
  },
  spam_score: { ops: [...PRESENCE_OPS, ...NUMBER_OPS], response: false },
  email_auth: { ops: ["eq", "neq"], key: "name", names: ["spf", "dkim", "dmarc"], response: false },
  signature: { ops: ["eq", "neq"], response: false },
};

/** Values `signature` compares with. */
export const SIGNATURE_STATES = ["verified", "failed", "missing"] as const;
export type SignatureState = (typeof SIGNATURE_STATES)[number];

export const MAX_CONDITIONS = 10;
export const MAX_CONDITION_VALUE_CHARS = 4096;
export const MAX_CONDITION_NAME_CHARS = 256;
export const MAX_CONDITION_PATH_CHARS = 256;
/** Glob and regular expression patterns. */
export const MAX_PATTERN_CHARS = 500;

/** The request a condition is checked against. */
export interface RuleSubject {
  kind?: "http" | "email";
  method: string;
  path: string;
  /** Header names in any case. */
  headers: Record<string, string>;
  query: Record<string, string>;
  /** The body as text; "" when there is none. */
  body: string;
  contentType?: string | null;
  size?: number | null;
  /** For emails: the parts conditions read. */
  email?: {
    subject: string | null;
    /** The sender's address. */
    from: string | null;
    /** To and Cc addresses. */
    to: string[];
    text: string | null;
    tag: string | null;
    spamScore: number | null;
    auth: { spf: string | null; dkim: string | null; dmarc: string | null };
    /** The endpoint's named fields: what each pattern found, or null. */
    fields?: Record<string, string | null> | null;
  } | null;
  /** The signature check, when one ran or is configured. */
  signature?: SignatureState | null;
}

/**
 * Tests a regular expression (RE2 syntax) against text. The default uses
 * JavaScript's RegExp, which is fine for your own data; the web app passes a
 * linear-time RE2 engine because it runs patterns against what anyone sends.
 */
export type RegexTester = (pattern: string, text: string) => boolean;

/**
 * JavaScript's RegExp, reading leading RE2 inline flags (`(?i)`, `(?s)`,
 * `(?m)` or a combination such as `(?is)`) as RegExp flags.
 */
export const nativeRegexTester: RegexTester = (pattern, text) => {
  let flags = "";
  let source = pattern;
  const inline = /^\(\?([ism]+)\)/.exec(source);
  if (inline) {
    flags = [...new Set(inline[1])].join("");
    source = source.slice(inline[0].length);
  }
  try {
    return new RegExp(source, flags).test(text);
  } catch {
    return false;
  }
};

export interface EvaluateOptions {
  regex?: RegexTester;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Splits a dot path into keys: `data.items.0.id`, with `["odd.key"]` for a
 * key holding a dot or a bracket. Empty segments are skipped. Returns null
 * when a bracket is malformed.
 *
 * `strict` (templates) allows only letters, digits, `_`, `-`, `$` and `@`
 * outside brackets, so a placeholder ends at a space or `|`.
 */
export function parsePath(path: string, strict = false): string[] | null {
  const keys: string[] = [];
  let current = "";
  let i = 0;
  const flush = () => {
    if (current !== "") keys.push(current);
    current = "";
  };
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      flush();
      i++;
      continue;
    }
    if (ch === "[") {
      flush();
      const end = readBracket(path, i);
      if (!end) return null;
      keys.push(end.key);
      i = end.next;
      continue;
    }
    if (strict && !/^[A-Za-z0-9_\-$@]$/.test(ch)) return null;
    current += ch;
    i++;
  }
  flush();
  return keys;
}

/** `["key"]` (with \" and \\ escapes) or `[123]` starting at `start`. */
function readBracket(path: string, start: number): { key: string; next: number } | null {
  let i = start + 1;
  if (path[i] === '"') {
    i++;
    let key = "";
    while (i < path.length) {
      const ch = path[i];
      if (ch === "\\") {
        const next = path[i + 1];
        if (next !== '"' && next !== "\\") return null;
        key += next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        if (path[i + 1] !== "]") return null;
        return { key, next: i + 2 };
      }
      key += ch;
      i++;
    }
    return null;
  }
  let digits = "";
  while (i < path.length && /^[0-9]$/.test(path[i])) {
    digits += path[i];
    i++;
  }
  if (digits === "" || path[i] !== "]") return null;
  return { key: digits, next: i + 1 };
}

/** The value at `keys` in a parsed JSON value, or undefined. */
export function walkPath(root: unknown, keys: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    if (Array.isArray(current)) {
      if (!/^[0-9]+$/.test(key)) return undefined;
      const index = Number(key);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A number as JavaScript prints it. */
export function formatNumber(n: number): string {
  return String(n);
}

/**
 * A JSON value as text: strings as they are, numbers as JavaScript prints
 * them, objects and arrays as compact JSON in their own key order.
 */
export function valueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

/** What `eq` compares: like valueToText, but null reads "null". */
function comparable(value: unknown): string {
  return value === null ? "null" : valueToText(value);
}

/**
 * The body as structured data: parsed JSON when it is JSON, form fields when
 * the content type is application/x-www-form-urlencoded (a repeated name
 * keeps its last value), otherwise undefined.
 */
export function parseStructuredBody(body: string, contentType?: string | null): unknown {
  if (body === "") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    // Not JSON.
  }
  if (contentType && contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    const fields: Record<string, string> = {};
    for (const [name, value] of new URLSearchParams(body)) fields[name] = value;
    return fields;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

/**
 * A glob as a regular expression source: `*` is anything but `/`, `**` is
 * anything (and takes a following `/` with it, so `/a/**\/b` matches `/a/b`),
 * `?` is one character other than `/`. The receiver translates globs the
 * same way.
 */
export function globToRegexSource(pattern: string): string {
  let source = "^";
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "*" && chars[i + 1] === "*") {
      source += ".*";
      i++;
      if (chars[i + 1] === "/") i++;
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return `${source}$`;
}

/** Whether `input` matches the glob as a whole (`*` and `**` also cross line breaks). */
export function globMatch(
  pattern: string,
  input: string,
  regex: RegexTester = nativeRegexTester
): boolean {
  if (pattern.length > MAX_PATTERN_CHARS) return false;
  return regex(`(?s)${globToRegexSource(pattern)}`, input);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** The field's value(s): a single value, a list (email recipients), or undefined when absent. */
type Resolved = { kind: "one"; value: unknown } | { kind: "many"; values: string[] };

class Body {
  private parsed: unknown;
  private done = false;
  constructor(
    private readonly text: string,
    private readonly contentType: string | null | undefined
  ) {}
  get(): unknown {
    if (!this.done) {
      this.parsed = parseStructuredBody(this.text, this.contentType);
      this.done = true;
    }
    return this.parsed;
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function resolve(condition: Condition, subject: RuleSubject, body: Body): Resolved {
  const one = (value: unknown): Resolved => ({ kind: "one", value });
  switch (condition.field) {
    case "method":
      return one(subject.method);
    case "path":
      return one(subject.path);
    case "header":
      return one(condition.name ? headerValue(subject.headers, condition.name) : undefined);
    case "query":
      return one(
        condition.name && Object.prototype.hasOwnProperty.call(subject.query, condition.name)
          ? subject.query[condition.name]
          : undefined
      );
    case "body":
    case "body_contains":
      return one(subject.body);
    case "body_path": {
      const keys = condition.path ? parsePath(condition.path) : null;
      if (!keys) return one(undefined);
      const root = body.get();
      return one(root === undefined ? undefined : walkPath(root, keys));
    }
    case "content_type":
      return one(subject.contentType ?? undefined);
    case "size":
      return one(subject.size ?? undefined);
    case "kind":
      return one(subject.kind ?? "http");
    case "email": {
      const email = subject.email;
      if (!email) return one(undefined);
      switch (condition.name) {
        case "subject":
          return one(email.subject ?? undefined);
        case "from":
          return one(email.from ?? undefined);
        case "to":
          return { kind: "many", values: email.to };
        case "text":
          return one(email.text ?? undefined);
        case "tag":
          return one(email.tag ?? undefined);
        default:
          return one(undefined);
      }
    }
    case "email_field": {
      const fields = subject.email?.fields;
      if (!fields || !condition.name) return one(undefined);
      return one(
        Object.prototype.hasOwnProperty.call(fields, condition.name)
          ? (fields[condition.name] ?? undefined)
          : undefined
      );
    }
    case "spam_score":
      return one(subject.email?.spamScore ?? undefined);
    case "email_auth": {
      const auth = subject.email?.auth;
      if (!auth || !condition.name) return one(undefined);
      const name = condition.name as keyof typeof auth;
      return one(
        Object.prototype.hasOwnProperty.call(auth, name) ? (auth[name] ?? undefined) : undefined
      );
    }
    case "signature":
      return one(subject.signature ?? "missing");
    default:
      return one(undefined);
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A positive string comparison on one present value. */
function compareOne(
  op: ConditionOp,
  field: ConditionField,
  actual: unknown,
  expected: string,
  regex: RegexTester
): boolean {
  const caseless = field === "method" || field === "content_type" || field === "kind";
  let text = comparable(actual);
  let target = expected;
  if (caseless) {
    text = text.toLowerCase();
    target = target.toLowerCase();
  }
  switch (op) {
    case "eq":
      return text === target;
    case "contains":
      return text.includes(target);
    case "starts_with":
      return text.startsWith(target);
    case "ends_with":
      return text.endsWith(target);
    case "matches":
      return globMatch(expected, comparable(actual), regex);
    case "regex":
      return expected.length <= MAX_PATTERN_CHARS && regex(expected, comparable(actual));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === null || b === null) return false;
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

const NEGATED: Partial<Record<ConditionOp, ConditionOp>> = {
  neq: "eq",
  not_contains: "contains",
};

/** Whether one condition holds. Unknown fields and operators never hold. */
export function evaluateCondition(
  condition: Condition,
  subject: RuleSubject,
  options: EvaluateOptions = {},
  body: Body = new Body(subject.body, subject.contentType)
): boolean {
  const spec = CONDITION_FIELDS[condition.field];
  if (!spec || !spec.ops.includes(condition.op)) return false;
  const regex = options.regex ?? nativeRegexTester;
  const resolved = resolve(condition, subject, body);
  const op = condition.op;

  if (op === "exists" || op === "not_exists") {
    const present =
      resolved.kind === "many"
        ? resolved.values.length > 0
        : resolved.value !== undefined &&
          !(condition.field === "spam_score" && resolved.value === null);
    return op === "exists" ? present : !present;
  }

  const expected = condition.value;
  if (expected === undefined || expected === null) return false;
  const positive = NEGATED[op] ?? op;
  const negate = positive !== op;

  let held: boolean;
  if (resolved.kind === "many") {
    held = resolved.values.some((value) =>
      compareOne(positive, condition.field, value, expected, regex)
    );
  } else if (resolved.value === undefined) {
    held = false;
  } else {
    held = compareOne(positive, condition.field, resolved.value, expected, regex);
  }
  return negate ? !held : held;
}

/**
 * Whether a group holds: every condition ("and") or any ("or"). A group
 * without conditions holds (a filter with nothing in it lets everything
 * through); response rules skip rules without conditions themselves.
 */
export function evaluateConditions(
  group: ConditionGroup,
  subject: RuleSubject,
  options: EvaluateOptions = {}
): boolean {
  if (group.conditions.length === 0) return true;
  const body = new Body(subject.body, subject.contentType);
  const test = (condition: Condition) => evaluateCondition(condition, subject, options, body);
  return group.logic === "or" ? group.conditions.some(test) : group.conditions.every(test);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  use: ConditionUse;
  /** Checks a regular expression's syntax; returns an error message or null. */
  checkRegex?: (pattern: string) => string | null;
  /** Checks that a glob's regex (`globToRegexSource`) can run; an error message or null. */
  checkGlob?: (glob: string) => string | null;
}

/** Problems with one condition, in words for the person who wrote it; [] when it is fine. */
export function conditionIssues(condition: unknown, options: ValidateOptions): string[] {
  if (condition === null || typeof condition !== "object" || Array.isArray(condition)) {
    return ["must be an object"];
  }
  const c = condition as Record<string, unknown>;
  const field = c.field as ConditionField;
  const spec = typeof c.field === "string" ? CONDITION_FIELDS[field] : undefined;
  if (!spec) return [`unknown field "${String(c.field)}"`];
  if (options.use === "response" && !spec.response) {
    return [
      `field "${field}" is only known after the response is sent; use it in a forwarding filter`,
    ];
  }
  const issues: string[] = [];
  if (typeof c.op !== "string" || !spec.ops.includes(c.op as ConditionOp)) {
    issues.push(`op "${String(c.op)}" is not valid for field "${field}"`);
    return issues;
  }
  const op = c.op as ConditionOp;
  for (const key of ["value", "name", "path"] as const) {
    if (c[key] !== undefined && c[key] !== null && typeof c[key] !== "string") {
      issues.push(`${key} must be a string`);
    }
  }
  if (issues.length > 0) return issues;
  const value = c.value as string | undefined;
  const name = c.name as string | undefined;
  const path = c.path as string | undefined;

  if (spec.key === "name") {
    if (!name) issues.push(`name is required for ${field} conditions`);
    else if (name.length > MAX_CONDITION_NAME_CHARS)
      issues.push(`name is too long (max ${MAX_CONDITION_NAME_CHARS} characters)`);
    else if (spec.names && !spec.names.includes(name))
      issues.push(`name must be one of ${spec.names.join(", ")}`);
  }
  if (spec.key === "path") {
    if (!path) issues.push(`path is required for ${field} conditions`);
    else if (path.length > MAX_CONDITION_PATH_CHARS)
      issues.push(`path is too long (max ${MAX_CONDITION_PATH_CHARS} characters)`);
    else if (!parsePath(path)) issues.push(`path "${path}" is not a valid dot path`);
  }
  if (op === "exists" || op === "not_exists") return issues;

  if (value === undefined || value === null) {
    issues.push(`value is required when op is "${op}"`);
    return issues;
  }
  if (value.length > MAX_CONDITION_VALUE_CHARS) {
    issues.push(`value is too long (max ${MAX_CONDITION_VALUE_CHARS} characters)`);
  }
  if ((op === "matches" || op === "regex") && value.length > MAX_PATTERN_CHARS) {
    issues.push(`pattern is too long (max ${MAX_PATTERN_CHARS} characters)`);
  } else if (op === "regex" && options.checkRegex) {
    const problem = options.checkRegex(value);
    if (problem) issues.push(`regex: ${problem}`);
  } else if (op === "matches" && options.checkGlob) {
    const problem = options.checkGlob(value);
    if (problem) issues.push(`glob: ${problem}`);
  }
  if (NUMBER_OPS.includes(op) && toNumber(value) === null) {
    issues.push(`value must be a number for "${op}"`);
  }
  if (field === "kind" && value !== "http" && value !== "email") {
    issues.push(`value must be "http" or "email"`);
  }
  if (field === "signature" && !(SIGNATURE_STATES as readonly string[]).includes(value)) {
    issues.push(`value must be one of ${SIGNATURE_STATES.join(", ")}`);
  }
  return issues;
}

/** Problems with a list of conditions, each prefixed with where it is. */
export function conditionsIssues(
  conditions: unknown,
  options: ValidateOptions,
  prefix = "conditions"
): string[] {
  if (!Array.isArray(conditions)) return [`${prefix} must be an array`];
  const issues: string[] = [];
  if (conditions.length > MAX_CONDITIONS) {
    issues.push(`${prefix}: at most ${MAX_CONDITIONS} conditions`);
  }
  conditions.forEach((condition, index) => {
    for (const issue of conditionIssues(condition, options)) {
      issues.push(`${prefix}[${index}]: ${issue}`);
    }
  });
  return issues;
}
