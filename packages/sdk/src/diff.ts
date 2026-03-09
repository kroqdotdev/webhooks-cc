import type { Request, SearchResult } from "./types";

export interface ValueDifference<T> {
  left: T;
  right: T;
}

export interface HeaderDiff {
  added: string[];
  removed: string[];
  changed: Record<string, ValueDifference<string>>;
}

export interface JsonBodyDiff {
  type: "json";
  changed: Record<string, ValueDifference<unknown>>;
  diff: string;
}

export interface TextBodyDiff {
  type: "text";
  diff: string;
}

export type BodyDiff = JsonBodyDiff | TextBodyDiff;

export interface RequestDifferences {
  method?: ValueDifference<string>;
  path?: ValueDifference<string>;
  headers?: HeaderDiff;
  body?: BodyDiff;
}

export interface DiffRequestsOptions {
  /** Header names to exclude from comparison. Matched case-insensitively. */
  ignoreHeaders?: string[];
}

export interface DiffResult {
  matches: boolean;
  differences: RequestDifferences;
}

type ComparableRequest = Pick<Request, "method" | "path" | "headers" | "body"> &
  Partial<Pick<Request, "queryParams" | "contentType">>;
type JsonChanges = Record<string, ValueDifference<unknown>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonBody(body: string): { valid: boolean; value?: unknown } {
  if (body.length === 0) {
    return { valid: false };
  }

  try {
    return { valid: true, value: JSON.parse(body) };
  } catch {
    return { valid: false };
  }
}

function areEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => areEqual(value, right[index]))
    );
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => areEqual(left[key], right[key]))
    );
  }

  return Number.isNaN(left) && Number.isNaN(right);
}

function compareJsonValues(
  left: unknown,
  right: unknown,
  path: string,
  changes: JsonChanges
): void {
  if (areEqual(left, right)) {
    return;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const maxLength = Math.max(left.length, right.length);
    for (let index = 0; index < maxLength; index++) {
      const nextPath = path ? `${path}.${index}` : String(index);
      compareJsonValues(left[index], right[index], nextPath, changes);
    }
    return;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const nextPath = path ? `${path}.${key}` : key;
      compareJsonValues(left[key], right[key], nextPath, changes);
    }
    return;
  }

  changes[path || "$"] = { left, right };
}

function formatJsonDiff(changes: JsonChanges): string {
  return Object.entries(changes)
    .map(
      ([path, difference]) =>
        `${path}: ${JSON.stringify(difference.left)} -> ${JSON.stringify(difference.right)}`
    )
    .join("\n");
}

function formatTextDiff(left: string, right: string): string {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const maxLength = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];

  for (let index = 0; index < maxLength; index++) {
    const leftLine = leftLines[index];
    const rightLine = rightLines[index];

    if (leftLine === rightLine) {
      continue;
    }
    if (leftLine !== undefined) {
      lines.push(`- ${leftLine}`);
    }
    if (rightLine !== undefined) {
      lines.push(`+ ${rightLine}`);
    }
  }

  return lines.join("\n");
}

function normalizeHeaders(
  headers: Record<string, string>,
  ignoredHeaders: Set<string>
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!ignoredHeaders.has(lowerKey)) {
      normalized[lowerKey] = value;
    }
  }

  return normalized;
}

function diffHeaders(
  leftHeaders: Record<string, string>,
  rightHeaders: Record<string, string>,
  options: DiffRequestsOptions
): HeaderDiff | undefined {
  const ignoredHeaders = new Set(
    (options.ignoreHeaders ?? []).map((header) => header.toLowerCase())
  );
  const left = normalizeHeaders(leftHeaders, ignoredHeaders);
  const right = normalizeHeaders(rightHeaders, ignoredHeaders);

  const leftKeys = new Set(Object.keys(left));
  const rightKeys = new Set(Object.keys(right));
  const added = [...rightKeys].filter((key) => !leftKeys.has(key)).sort();
  const removed = [...leftKeys].filter((key) => !rightKeys.has(key)).sort();

  const changed: Record<string, ValueDifference<string>> = {};
  for (const key of [...leftKeys].filter((header) => rightKeys.has(header)).sort()) {
    if (left[key] !== right[key]) {
      changed[key] = { left: left[key], right: right[key] };
    }
  }

  if (added.length === 0 && removed.length === 0 && Object.keys(changed).length === 0) {
    return undefined;
  }

  return { added, removed, changed };
}

function diffBodies(
  leftBody: string | undefined,
  rightBody: string | undefined
): BodyDiff | undefined {
  const left = leftBody ?? "";
  const right = rightBody ?? "";

  if (left === right) {
    return undefined;
  }

  const leftJson = isJsonBody(left);
  const rightJson = isJsonBody(right);

  if (leftJson.valid && rightJson.valid) {
    const changed: JsonChanges = {};
    compareJsonValues(leftJson.value, rightJson.value, "", changed);
    if (Object.keys(changed).length === 0) {
      return undefined;
    }

    return {
      type: "json",
      changed,
      diff: formatJsonDiff(changed),
    };
  }

  return {
    type: "text",
    diff: formatTextDiff(left, right),
  };
}

/**
 * Compare two requests and return a structured diff suitable for debugging or tooling.
 */
export function diffRequests(
  left: ComparableRequest | SearchResult,
  right: ComparableRequest | SearchResult,
  options: DiffRequestsOptions = {}
): DiffResult {
  const differences: RequestDifferences = {};

  if (left.method !== right.method) {
    differences.method = { left: left.method, right: right.method };
  }

  if (left.path !== right.path) {
    differences.path = { left: left.path, right: right.path };
  }

  const headerDiff = diffHeaders(left.headers, right.headers, options);
  if (headerDiff) {
    differences.headers = headerDiff;
  }

  const bodyDiff = diffBodies(left.body, right.body);
  if (bodyDiff) {
    differences.body = bodyDiff;
  }

  return {
    matches: Object.keys(differences).length === 0,
    differences,
  };
}
