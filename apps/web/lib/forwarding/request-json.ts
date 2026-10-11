import type { RequestRecord } from "@/lib/supabase/requests";
import { isoMillis, requestBodyBytes } from "./relay";

/**
 * A captured HTTP request as signed JSON, for owners who picked "Signed JSON"
 * so one handler takes both kinds: the same envelope as an email's
 * (`type`, `timestamp`, `data`), signed with the Standard Webhooks headers
 * (sign.ts). The body is text when it is valid UTF-8, otherwise base64.
 */

export const REQUEST_RECEIVED = "request.received";

export interface RequestReceivedEvent {
  type: typeof REQUEST_RECEIVED;
  timestamp: string;
  data: {
    id: string;
    endpoint: { slug: string; name: string | null };
    receivedAt: string;
    method: string;
    path: string;
    /** The query string as sent, without the "?". */
    query: string | null;
    headers: Record<string, string>;
    contentType: string | null;
    ip: string;
    size: number;
    /** The body as text, or null when it is empty or not UTF-8. */
    body: string | null;
    /** The exact bytes in base64 when the body is not valid UTF-8. */
    bodyBase64: string | null;
  };
}

export function buildRequestJson(
  request: RequestRecord,
  endpoint: { slug: string; name: string | null }
): RequestReceivedEvent {
  const receivedAt = isoMillis(request.receivedAt);
  const raw = request.bodyRaw ? requestBodyBytes(request) : null;
  return {
    type: REQUEST_RECEIVED,
    timestamp: receivedAt,
    data: {
      id: request.id,
      endpoint: { slug: endpoint.slug, name: endpoint.name },
      receivedAt,
      method: request.method,
      path: request.path,
      query: request.queryRaw?.replace(/^\?/, "") || null,
      headers: request.headers ?? {},
      contentType: request.contentType ?? null,
      ip: request.ip,
      size: request.size,
      body: raw ? null : request.body || null,
      bodyBase64: raw ? raw.toString("base64") : null,
    },
  };
}
