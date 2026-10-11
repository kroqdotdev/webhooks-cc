import { decryptSigningSecret, encryptSigningSecret } from "@/lib/crypto";
import {
  MAX_HEADER_VALUE_CHARS,
  MAX_OWNER_HEADERS,
  headerValueAllowed,
  refusedHeaderName,
} from "./header-rules";

/**
 * Headers an endpoint's owner adds to forwarded requests (for example the
 * destination's `Authorization`). Stored as one encrypted JSON array, like
 * signing secrets; the API shows the names and a masked value, and saving
 * replaces the whole set. The rules themselves live in header-rules.ts, which
 * the dashboard imports too.
 */

export {
  MAX_OWNER_HEADERS,
  MAX_HEADER_NAME_CHARS,
  MAX_HEADER_VALUE_CHARS,
  headerNameIssue,
  refusedHeaderName,
} from "./header-rules";

export type OwnerHeader = [string, string];

export type OwnerHeadersCheck = { ok: true; headers: OwnerHeader[] } | { ok: false; error: string };

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
    if (value === null || !headerValueAllowed(value)) {
      return {
        ok: false,
        error: `The value of ${name} must be text up to ${MAX_HEADER_VALUE_CHARS} characters on one line.`,
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

function maskValue(value: string): string {
  return value.length <= 8 ? "••••" : `••••${value.slice(-4)}`;
}

/** Authorization schemes shown in the clear; any other first word may be part of the secret. */
const SCHEMES = new Set(["basic", "bearer", "bot", "digest", "token", "apikey"]);

/**
 * What the dashboard shows: the name, a known scheme such as "Bearer" when
 * the value starts with one, and the last four characters of a long value.
 */
export function maskOwnerHeaders(headers: OwnerHeader[]): { name: string; value: string }[] {
  return headers.map(([name, value]) => {
    const scheme = /^([A-Za-z]+) (\S.*)$/.exec(value);
    return {
      name,
      value:
        scheme && SCHEMES.has(scheme[1].toLowerCase())
          ? `${scheme[1]} ${maskValue(scheme[2])}`
          : maskValue(value),
    };
  });
}
