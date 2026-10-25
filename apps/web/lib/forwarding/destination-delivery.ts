import { emailFieldValues } from "@/lib/email-fields";
import { serverEnv } from "@/lib/env";
import type { EndpointRecord } from "@/lib/supabase/endpoints";
import type { Destination } from "@/lib/supabase/destinations";
import { getNewestRequestId } from "@/lib/supabase/forwarding";
import { getRequestsByIds, type RequestRecord } from "@/lib/supabase/requests";
import { sendOptions } from "./config";
import { resolveFormat, type ForwardFormat } from "./format";
import { isDelivered, sendForward, type SendResult } from "./send";
import { sampleEmailSource, sampleHttpRequest } from "./sample";
import { filterVerdict, outgoingFor, type DeliveryFacts } from "./worker";

/**
 * What a destination sends for one captured request, worked out the way the
 * worker does (lib/forwarding/worker.ts): for the test delivery, which sends
 * it once, and for the preview, which only shows it.
 */

/** The fields of a destination that decide what goes out. */
export type DestinationDraft = Pick<
  Destination,
  | "url"
  | "http"
  | "email"
  | "format"
  | "filter"
  | "bodyTemplate"
  | "messageTemplate"
  | "appendPath"
  | "sentField"
>;

/** The request to send: `requestId`, or the newest of the kind, or a sample. */
export async function pickRequest(
  endpoint: Pick<EndpointRecord, "id" | "slug">,
  options: {
    requestId?: string | null;
    kind?: "http" | "email" | null;
    destination: DestinationDraft;
  }
): Promise<{ request: RequestRecord; sample: boolean } | { error: string; status: number }> {
  if (options.requestId) {
    const [request] = await getRequestsByIds([options.requestId]);
    if (!request || request.endpointId !== endpoint.id) {
      return { error: "That request is not on this endpoint.", status: 404 };
    }
    return { request, sample: false };
  }
  const kind =
    options.kind ?? (options.destination.http || !options.destination.email ? "http" : "email");
  const newestId = await getNewestRequestId(endpoint.id, kind);
  const [newest] = newestId ? await getRequestsByIds([newestId]) : [];
  if (newest) return { request: newest, sample: false };
  if (kind === "http") return { request: sampleHttpRequest(endpoint.id), sample: true };
  const sample = sampleEmailSource(`${endpoint.slug}@${serverEnv().EMAIL_CAPTURE_DOMAIN}`);
  return {
    request: {
      id: sample.id,
      endpointId: endpoint.id,
      method: "EMAIL",
      path: sample.path,
      headers: sample.headers,
      queryParams: {},
      ip: "127.0.0.1",
      size: sample.size,
      receivedAt: sample.receivedAt,
      kind: "email",
      email: sample.email,
    },
    sample: true,
  };
}

export interface PreparedDelivery {
  format: ForwardFormat;
  /** Whether the filter lets the request through (signature still pending counts as yes). */
  passes: boolean;
  outgoing: ReturnType<typeof outgoingFor>;
  facts: DeliveryFacts;
}

/** The outgoing request for one destination and one captured request. */
export function prepareDelivery(
  endpoint: Pick<
    EndpointRecord,
    "slug" | "name" | "showEmailExtracts" | "signingProvider" | "emailFields"
  >,
  destination: DestinationDraft,
  request: RequestRecord,
  secret: string,
  ownerHeaders: [string, string][],
  mailgunSigningKey: string | null = null
): PreparedDelivery {
  const verdict = filterVerdict(
    (destination.filter as never) ?? null,
    request,
    endpoint.signingProvider ?? null,
    Date.now(),
    emailFieldValues(request, endpoint.emailFields ?? [])
  );
  const outgoing = outgoingFor(request, {
    url: destination.url,
    format: destination.format === "auto" ? null : destination.format,
    appendPath: destination.appendPath,
    slug: endpoint.slug,
    name: endpoint.name ?? null,
    showEmailExtracts: endpoint.showEmailExtracts,
    ownerHeaders,
    attempt: 1,
    secret,
    sentField: destination.sentField,
    bodyTemplate: destination.bodyTemplate,
    messageTemplate: destination.messageTemplate,
    emailFields: endpoint.emailFields ?? [],
    mailgunSigningKey,
  });
  return {
    format: resolveFormat(
      request.kind,
      destination.format === "auto" ? null : destination.format,
      destination.url
    ),
    passes: verdict !== "skip",
    outgoing,
    facts: outgoing.facts,
  };
}

/** The outgoing request as the API shows it: text when it is UTF-8, else base64. */
export function describeOutgoing(prepared: PreparedDelivery) {
  if ("reason" in prepared.outgoing) return null;
  const { outgoing } = prepared.outgoing;
  const body = outgoing.body;
  let text: string | null = null;
  if (body) {
    const decoded = body.toString("utf8");
    text = Buffer.from(decoded, "utf8").equals(body) ? decoded : null;
  }
  return {
    method: outgoing.method,
    url: outgoing.url,
    headers: Object.fromEntries(outgoing.headers),
    body: text,
    bodyBase64: body && text === null ? body.toString("base64") : null,
  };
}

/** Sends a prepared delivery once (a test): the result, or why it could not go. */
export async function sendPrepared(
  prepared: PreparedDelivery
): Promise<
  | { sent: true; result: SendResult & { delivered: boolean; url: string } }
  | { sent: false; reason: string }
> {
  if ("reason" in prepared.outgoing) return { sent: false, reason: prepared.outgoing.reason };
  const result = await sendForward(prepared.outgoing.outgoing, sendOptions());
  return {
    sent: true,
    result: { ...result, delivered: isDelivered(result), url: prepared.outgoing.outgoing.url },
  };
}
