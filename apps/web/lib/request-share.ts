/**
 * Shared request snapshots (migration 00062): what a share link shows, and
 * what it hides. Pure, so the share dialog previews exactly what the server
 * will store.
 */

import type { Request } from "@/types/request";

export const SHARE_EXPIRY_DAYS = [1, 7, 30] as const;
export type ShareExpiryDays = (typeof SHARE_EXPIRY_DAYS)[number];
export const DEFAULT_SHARE_EXPIRY_DAYS: ShareExpiryDays = 7;
/** Live links per user. */
export const MAX_ACTIVE_SHARES = 100;
/** Characters of body a snapshot keeps; the rest is cut and marked. */
export const SHARE_BODY_LIMIT = 256 * 1024;
export const REDACTED = "[redacted]";
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/** Headers that carry credentials: never shared. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Names that usually hold secrets, signatures or one-time values: hidden
 * unless the user chooses to show them (a signature is often what a
 * teammate needs to see).
 */
const SENSITIVE_NAME =
  /token|secret|passw|api[-_]?key|apikey|key$|signature|hmac|session|csrf|xsrf|auth|jwt|assertion|credential/i;
const SENSITIVE_QUERY_NAME = /^(code|key|sig|state)$/i;

export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.toLowerCase());
}

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

function redact(
  values: Record<string, string>,
  hide: (name: string) => boolean
): { values: Record<string, string>; redacted: string[] } {
  const out: Record<string, string> = {};
  const redacted: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (hide(name)) {
      out[name] = REDACTED;
      redacted.push(name);
    } else {
      out[name] = value;
    }
  }
  return { values: out, redacted };
}

export function redactHeaders(headers: Record<string, string>, hideSensitive: boolean) {
  return redact(
    headers,
    (name) => isCredentialHeader(name) || (hideSensitive && isSensitiveName(name))
  );
}

export function redactQuery(query: Record<string, string>, hideSensitive: boolean) {
  return redact(
    query,
    (name) => hideSensitive && (isSensitiveName(name) || SENSITIVE_QUERY_NAME.test(name))
  );
}

/** The request fields a snapshot is built from. */
export interface ShareSource {
  method: string;
  path: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  body?: string;
  bodyRaw?: string;
  contentType?: string;
  size: number;
  receivedAt: number;
  detectedProvider?: string | null;
  detectedEvent?: string | null;
  signatureVerified?: boolean | null;
  signingProvider?: string | null;
}

export interface ShareSnapshot {
  v: 1;
  method: string;
  path: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  /** Names whose values were replaced with REDACTED. */
  redactedHeaders: string[];
  redactedQuery: string[];
  contentType: string | null;
  body: string | null;
  bodyTruncated: boolean;
  /** The body was not UTF-8; `body` is its text form. */
  bodyNotUtf8: boolean;
  size: number;
  receivedAt: number;
  detectedProvider: string | null;
  detectedEvent: string | null;
  signatureVerified: boolean | null;
  signingProvider: string | null;
}

/** The first SHARE_BODY_LIMIT characters, never ending on half a surrogate pair. */
function cutBody(body: string): string {
  const end = SHARE_BODY_LIMIT;
  const last = body.charCodeAt(end - 1);
  return body.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

export function buildShareSnapshot(
  source: ShareSource,
  options: { hideSensitive: boolean }
): ShareSnapshot {
  const headers = redactHeaders(source.headers, options.hideSensitive);
  const query = redactQuery(source.queryParams, options.hideSensitive);
  const body = source.body ?? null;
  const bodyTruncated = body !== null && body.length > SHARE_BODY_LIMIT;
  return {
    v: 1,
    method: source.method,
    path: source.path,
    headers: headers.values,
    queryParams: query.values,
    redactedHeaders: headers.redacted,
    redactedQuery: query.redacted,
    contentType: source.contentType ?? null,
    body: bodyTruncated ? cutBody(body) : body,
    bodyTruncated,
    bodyNotUtf8: Boolean(source.bodyRaw),
    size: source.size,
    receivedAt: source.receivedAt,
    detectedProvider: source.detectedProvider ?? null,
    detectedEvent: source.detectedEvent ?? null,
    signatureVerified: source.signatureVerified ?? null,
    signingProvider: source.signingProvider ?? null,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const nullableString = (value: unknown) => (typeof value === "string" ? value : null);

/** A stored snapshot, checked field by field; null for anything else. */
export function parseShareSnapshot(value: unknown): ShareSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (
    s.v !== 1 ||
    typeof s.method !== "string" ||
    typeof s.path !== "string" ||
    !isStringRecord(s.headers) ||
    !isStringRecord(s.queryParams) ||
    !isStringArray(s.redactedHeaders) ||
    !isStringArray(s.redactedQuery) ||
    typeof s.size !== "number" ||
    typeof s.receivedAt !== "number"
  ) {
    return null;
  }
  return {
    v: 1,
    method: s.method,
    path: s.path,
    headers: s.headers,
    queryParams: s.queryParams,
    redactedHeaders: s.redactedHeaders,
    redactedQuery: s.redactedQuery,
    contentType: nullableString(s.contentType),
    body: nullableString(s.body),
    bodyTruncated: s.bodyTruncated === true,
    bodyNotUtf8: s.bodyNotUtf8 === true,
    size: s.size,
    receivedAt: s.receivedAt,
    detectedProvider: nullableString(s.detectedProvider),
    detectedEvent: nullableString(s.detectedEvent),
    signatureVerified: typeof s.signatureVerified === "boolean" ? s.signatureVerified : null,
    signingProvider: nullableString(s.signingProvider),
  };
}

/** A snapshot in the shape the request inspector renders. */
export function snapshotToRequest(snapshot: ShareSnapshot, id: string): Request {
  return {
    _id: id,
    _creationTime: snapshot.receivedAt,
    endpointId: "",
    method: snapshot.method,
    path: snapshot.path,
    headers: snapshot.headers,
    body: snapshot.body ?? undefined,
    queryParams: snapshot.queryParams,
    contentType: snapshot.contentType ?? undefined,
    // The sender's address is not part of a share.
    ip: "",
    size: snapshot.size,
    receivedAt: snapshot.receivedAt,
    signatureVerified: snapshot.signatureVerified,
    signingProvider: snapshot.signingProvider,
    detectedProvider: snapshot.detectedProvider,
    detectedEvent: snapshot.detectedEvent,
    kind: "http",
  };
}
