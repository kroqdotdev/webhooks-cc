import { createHmac } from "node:crypto";
import type { RequestRecord } from "@/lib/supabase/requests";
import { secretKey } from "./sign";

/**
 * Forwarding a captured HTTP request as received: the same method, the
 * stored headers (minus connection-level ones), the exact body bytes and the
 * query string as sent, to the forwarding URL with the captured path after
 * the slug appended (unless the owner turned that off). The provider's own
 * signature headers pass through untouched, so they still verify; nothing
 * named `webhook-*` is added, because Standard Webhooks senders use those.
 *
 * Added on every relay: our metadata headers, signed with the forwarding
 * secret, then the owner's own headers.
 */

export const RELAY_HEADER = {
  receivedAt: "webhooks-cc-received-at",
  requestId: "webhooks-cc-request-id",
  endpoint: "webhooks-cc-endpoint",
  attempt: "webhooks-cc-attempt",
  signature: "webhooks-cc-signature",
} as const;

/** Never relayed: connection-level headers, and what the sender sets itself. */
const DROPPED = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

export interface Outgoing {
  method: string;
  url: string;
  headers: [string, string][];
  body: Buffer | null;
  /** relay: any method and headers; forward: a JSON POST (signed JSON, chat). */
  mode: "relay" | "forward";
}

/** RFC 3339 UTC with milliseconds, as the receiver writes `receivedAt`. */
export function isoMillis(ms: number): string {
  return new Date(ms).toISOString();
}

const PATH_SAFE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/;

/** The stored path is percent-decoded; encode what a URL path cannot hold. */
function encodePath(path: string): string {
  let out = "";
  for (const char of path) {
    out += PATH_SAFE.test(char)
      ? char
      : Array.from(Buffer.from(char, "utf8"))
          .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
          .join("");
  }
  return out;
}

/**
 * The forwarding URL, with the captured path appended and the captured query
 * after any query the URL has itself.
 */
export function destinationUrl(
  forwardUrl: string,
  path: string,
  queryRaw: string | null | undefined,
  appendPath: boolean
): string {
  const url = new URL(forwardUrl);
  if (appendPath && path && path !== "/") {
    const base = url.pathname.replace(/\/+$/, "");
    url.pathname = `${base}${encodePath(path.startsWith("/") ? path : `/${path}`)}`;
  }
  const own = url.search.replace(/^\?/, "");
  const captured = (queryRaw ?? "").replace(/^\?/, "");
  const query = [own, captured].filter(Boolean).join("&");
  url.search = query ? `?${query}` : "";
  return url.toString();
}

/** The exact bytes the sender posted. */
export function requestBodyBytes(request: RequestRecord): Buffer | null {
  if (request.bodyRaw) return Buffer.from(request.bodyRaw, "base64");
  if (request.body !== undefined && request.body !== null && request.body !== "") {
    return Buffer.from(request.body, "utf8");
  }
  return null;
}

/** "v1," and the base64 HMAC-SHA256 of "<request id>.<received at>." followed by the body bytes. */
export function relaySignature(
  secret: string,
  requestId: string,
  receivedAt: string,
  body: Buffer | null
): string {
  const mac = createHmac("sha256", secretKey(secret)).update(`${requestId}.${receivedAt}.`);
  if (body) mac.update(body);
  return `v1,${mac.digest("base64")}`;
}

export function buildRelay(
  request: RequestRecord,
  options: {
    forwardUrl: string;
    appendPath: boolean;
    slug: string;
    attempt: number;
    secret: string;
    ownerHeaders: [string, string][];
  }
): Outgoing {
  const body =
    request.method === "GET" || request.method === "HEAD" ? null : requestBodyBytes(request);
  const receivedAt = isoMillis(request.receivedAt);
  const headers: [string, string][] = [];
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const lower = name.toLowerCase();
    if (DROPPED.has(lower) || lower.startsWith("proxy-") || lower.startsWith("webhooks-cc-")) {
      continue;
    }
    headers.push([lower, value]);
  }
  headers.push(
    [RELAY_HEADER.receivedAt, receivedAt],
    [RELAY_HEADER.requestId, request.id],
    [RELAY_HEADER.endpoint, options.slug],
    [RELAY_HEADER.attempt, String(options.attempt)],
    [RELAY_HEADER.signature, relaySignature(options.secret, request.id, receivedAt, body)]
  );
  // The owner's headers replace a captured header of the same name.
  const owned = new Set(options.ownerHeaders.map(([name]) => name.toLowerCase()));
  const merged = headers.filter(([name]) => !owned.has(name));
  merged.push(...options.ownerHeaders.map(([name, value]): [string, string] => [name, value]));

  return {
    method: request.method,
    url: destinationUrl(options.forwardUrl, request.path, request.queryRaw, options.appendPath),
    headers: merged,
    body,
    mode: "relay",
  };
}
