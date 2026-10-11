import { PROXY_CONTROL_HEADERS } from "./proxy-headers";

/**
 * The rules for the headers an endpoint's owner adds to forwarded requests:
 * how many, how long, which names are refused. Pure and free of server
 * imports, so the dashboard checks a row as it is typed with the same rules
 * the route applies (owner-headers.ts, which imports and re-exports them).
 */

export const MAX_OWNER_HEADERS = 10;
export const MAX_HEADER_NAME_CHARS = 64;
export const MAX_HEADER_VALUE_CHARS = 1024;

/** RFC 9110 token characters. */
export const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Set by the delivery itself, or hop-by-hop: never taken from the owner. */
export const DELIVERY_SET_HEADERS = new Set([
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

export type HeaderNameIssue =
  /** Empty, too long, or not a token. */
  | "invalid"
  /** Host, Content-Length, Transfer-Encoding, cf-*, the proxy's own headers. */
  | "delivery"
  /** webhook-*: Standard Webhooks signatures. */
  | "webhook"
  /** webhooks-cc-*: the metadata webhooks.cc adds. */
  | "webhooks-cc";

/** Why a header name cannot be added, as a category, or null when it can. */
export function headerNameIssue(name: string): HeaderNameIssue | null {
  if (!name || name.length > MAX_HEADER_NAME_CHARS || !HEADER_TOKEN.test(name)) return "invalid";
  const lower = name.toLowerCase();
  // The notify proxy drops cf-* and proxy-* headers (infra/notify-proxy relay mode).
  if (DELIVERY_SET_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("cf-")) {
    return "delivery";
  }
  if (lower.startsWith("webhook-")) return "webhook";
  if (lower.startsWith("webhooks-cc-")) return "webhooks-cc";
  if (PROXY_CONTROL_HEADERS.has(lower)) return "delivery";
  return null;
}

/** Why a header name cannot be added, as the API says it, or null when it can. */
export function refusedHeaderName(name: string): string | null {
  switch (headerNameIssue(name)) {
    case "invalid":
      return `"${name.slice(0, MAX_HEADER_NAME_CHARS)}" is not a valid header name.`;
    case "delivery":
      return PROXY_CONTROL_HEADERS.has(name.toLowerCase())
        ? `${name} is reserved by webhooks.cc.`
        : name.toLowerCase().startsWith("cf-")
          ? `${name} is set by Cloudflare on the way out and cannot be added.`
          : `${name} is set by the request itself and cannot be added.`;
    case "webhook":
      return `${name} is reserved for Standard Webhooks signatures.`;
    case "webhooks-cc":
      return `${name} is reserved for the headers webhooks.cc adds.`;
    default:
      return null;
  }
}

/** Whether a value can be stored: one line of text, within the limit. */
export function headerValueAllowed(value: string): boolean {
  return value.length <= MAX_HEADER_VALUE_CHARS && !/[\r\n\0]/.test(value);
}
