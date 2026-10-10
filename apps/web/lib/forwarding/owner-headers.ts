import { decryptSigningSecret, encryptSigningSecret } from "@/lib/crypto";
import { PROXY_CONTROL_HEADERS } from "./proxy-headers";

/**
 * Headers an endpoint's owner adds to forwarded requests (for example the
 * destination's `Authorization`). Stored as one encrypted JSON array, like
 * signing secrets; the API shows the names and a masked value, and saving
 * replaces the whole set.
 */

export const MAX_OWNER_HEADERS = 10;
const MAX_NAME = 64;
const MAX_VALUE = 1024;
/** RFC 9110 token characters. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const REFUSED = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "expect",
]);

export type OwnerHeader = [string, string];

export type OwnerHeadersCheck = { ok: true; headers: OwnerHeader[] } | { ok: false; error: string };

/** Why a header name cannot be added, or null when it can. */
export function refusedHeaderName(name: string): string | null {
  const lower = name.toLowerCase();
  if (!name || name.length > MAX_NAME || !TOKEN.test(name)) {
    return `"${name.slice(0, MAX_NAME)}" is not a valid header name.`;
  }
  if (REFUSED.has(lower) || lower.startsWith("proxy-")) {
    return `${name} is set by the request itself and cannot be added.`;
  }
  if (lower.startsWith("webhook-")) {
    return `${name} is reserved for Standard Webhooks signatures.`;
  }
  if (lower.startsWith("webhooks-cc-")) {
    return `${name} is reserved for the headers webhooks.cc adds.`;
  }
  if (PROXY_CONTROL_HEADERS.has(lower)) {
    return `${name} is reserved by webhooks.cc.`;
  }
  return null;
}

/** Validates a set the owner submitted: `[{ name, value }]`. */
export function checkOwnerHeaders(input: unknown): OwnerHeadersCheck {
  if (!Array.isArray(input)) return { ok: false, error: "headers must be a list." };
  if (input.length > MAX_OWNER_HEADERS) {
    return { ok: false, error: `Add at most ${MAX_OWNER_HEADERS} headers.` };
  }
  const seen = new Set<string>();
  const headers: OwnerHeader[] = [];
  for (const item of input) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const value = typeof item?.value === "string" ? item.value : null;
    const refused = refusedHeaderName(name);
    if (refused) return { ok: false, error: refused };
    if (value === null || value.length > MAX_VALUE || /[\r\n\0]/.test(value)) {
      return {
        ok: false,
        error: `The value of ${name} must be text up to ${MAX_VALUE} characters on one line.`,
      };
    }
    if (seen.has(name.toLowerCase())) return { ok: false, error: `${name} is listed twice.` };
    seen.add(name.toLowerCase());
    headers.push([name, value]);
  }
  return { ok: true, headers };
}

export function encryptOwnerHeaders(headers: OwnerHeader[]): Buffer | null {
  return headers.length === 0 ? null : encryptSigningSecret(JSON.stringify(headers));
}

export function decryptOwnerHeaders(encrypted: Buffer | null | undefined): OwnerHeader[] {
  if (!encrypted || encrypted.length === 0) return [];
  const parsed: unknown = JSON.parse(decryptSigningSecret(encrypted));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (pair): pair is OwnerHeader =>
      Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"
  );
}

/** What the dashboard shows: the name, and the value's last four characters at most. */
export function maskOwnerHeaders(headers: OwnerHeader[]): { name: string; value: string }[] {
  return headers.map(([name, value]) => ({
    name,
    value: value.length <= 8 ? "••••" : `••••${value.slice(-4)}`,
  }));
}
