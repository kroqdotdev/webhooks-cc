import { decryptSigningSecret } from "@/lib/crypto";
import { buildEmailJson } from "@webhooks-cc/sdk/email";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database";
import { getRequestsByIds, type RequestRecord } from "@/lib/supabase/requests";
import { chatPayload, CHAT_MESSAGE_CHARS, CHAT_PREVIEW_CHARS, truncatePreview } from "./chat";
import { retryDelaySeconds } from "./schedule";
import { sendOptions } from "./config";
import { resolveFormat } from "./format";
import { decryptOwnerHeaders } from "./owner-headers";
import { buildRelay, isoMillis, requestBodyBytes, type Outgoing } from "./relay";
import { isDelivered, jsonForward, sendForward, type SendResult } from "./send";
import { forwardHeaders, FORWARD_USER_AGENT } from "./sign";

/**
 * Sends forwarded requests. capture_webhook() queues a delivery for every
 * captured request of a kind the endpoint forwards (migrations 00050 and
 * 00058); this loop claims due deliveries with a lease, sends each one in its
 * format (format.ts: an HTTP request as received, an email as signed JSON,
 * either as a chat message to Slack or Discord) and records the outcome,
 * which schedules the next try (schedule.ts) within the endpoint's retry
 * window or settles the delivery.
 *
 * One loop per process, started from instrumentation.ts. Several processes
 * may run it: the claim never hands one delivery to two of them, and a
 * process that stops mid-send leaves a lease that runs out, so the delivery
 * is tried again later.
 */

/** How often to look for work when there was none lately, and while there is. */
const IDLE_POLL_MS = 1000;
const BUSY_POLL_MS = 200;
/** After the last claimed delivery, keep polling fast this long. */
const BUSY_FOR_MS = 5000;
/** Deliveries in flight at once, per process. */
const CONCURRENCY = 8;
const PER_ENDPOINT = 2;
/** Longer than a send can take (FORWARD_TIMEOUT_MS plus the proxy's margin). */
const LEASE_SECONDS = 60;
/** The notify proxy's cap (infra/notify-proxy); a larger body could never be delivered. */
const MAX_FORWARD_BYTES = 10 * 1024 * 1024;

type Claim = Database["public"]["Functions"]["claim_email_deliveries"]["Returns"][number];

/** The forwarded body and its signed headers for one email (the signed JSON format). */
export function forwardRequest(
  request: RequestRecord,
  endpoint: { slug: string; name: string | null },
  secret: string,
  includeExtracts: boolean
): { body: string; headers: Record<string, string> } | null {
  if (request.kind !== "email" || !request.email) return null;
  const body = JSON.stringify(
    buildEmailJson({ ...request, email: request.email }, endpoint, { includeExtracts })
  );
  return { body, headers: forwardHeaders(secret, request.id, body) };
}

/** Postgres text cannot hold NUL; a response that has one must still be recorded. */
function storable(text: string | null): string | null {
  return text === null ? null : text.replaceAll("\u0000", "");
}

/**
 * Seconds until the next try, or null when the endpoint's retry window
 * (counted from when the delivery was queued) would be over by then.
 */
export function nextRetry(
  attempt: number,
  queuedAt: string,
  windowSeconds: number,
  now: number = Date.now()
): number | null {
  const delay = retryDelaySeconds(attempt);
  if (delay === null || windowSeconds <= 0) return null;
  const queued = Date.parse(queuedAt);
  if (!Number.isFinite(queued)) return delay;
  return now + delay * 1000 <= queued + windowSeconds * 1000 ? delay : null;
}

async function record(claim: Claim, result: SendResult, retry: boolean): Promise<void> {
  const delivered = isDelivered(result);
  const error = storable(
    result.error ?? (delivered ? null : `The URL answered ${result.status ?? "nothing"}.`)
  );
  const { error: rpcError } = await createAdminClient().rpc("record_email_delivery_attempt", {
    p_delivery_id: claim.delivery_id,
    p_attempt: claim.attempt,
    p_succeeded: delivered,
    p_status: result.status,
    p_duration_ms: result.durationMs,
    p_error: error,
    p_response_excerpt: storable(result.excerpt),
    p_retry_in_seconds:
      delivered || !retry
        ? null
        : nextRetry(claim.attempt, claim.queued_at, claim.forward_retry_seconds),
  });
  if (rpcError) throw rpcError;
}

/** A chat message for one captured request (format.ts picks this for Slack and Discord). */
export function chatForward(request: RequestRecord, slug: string, url: string): Outgoing {
  const isEmail = request.kind === "email" && request.email;
  const text = isEmail
    ? [request.email?.subject, request.email?.text].filter(Boolean).join("\n")
    : (requestBodyBytes(request)?.toString("utf8") ?? "");
  const payload = chatPayload({
    slug,
    method: isEmail ? "EMAIL" : request.method,
    path: request.path,
    ip: request.ip,
    receivedAt: isoMillis(request.receivedAt),
    preview: truncatePreview(text, CHAT_PREVIEW_CHARS),
    body: truncatePreview(text, CHAT_MESSAGE_CHARS),
    targetUrl: url,
  });
  return jsonForward(
    url,
    { "content-type": "application/json", "user-agent": FORWARD_USER_AGENT },
    JSON.stringify(payload)
  );
}

export interface OutgoingSettings {
  url: string;
  /** endpoints.forward_format: null picks from the URL. */
  format: string | null;
  appendPath: boolean;
  slug: string;
  name: string | null;
  showEmailExtracts: boolean;
  ownerHeaders: [string, string][];
  attempt: number;
  secret: string;
}

/**
 * The outgoing request for one captured request with an endpoint's
 * forwarding settings, or why it cannot be sent at all. Used by the worker
 * and by the test delivery, so a test sends what a real delivery would.
 */
export function outgoingFor(
  request: RequestRecord,
  settings: OutgoingSettings
): { outgoing: Outgoing } | { reason: string } {
  const format = resolveFormat(request.kind, settings.format, settings.url);
  if (format === "chat") return { outgoing: chatForward(request, settings.slug, settings.url) };
  if (request.kind === "email") {
    const prepared = forwardRequest(
      request,
      { slug: settings.slug, name: settings.name },
      settings.secret,
      settings.showEmailExtracts
    );
    if (!prepared) return { reason: "The email could not be read." };
    const headers = { ...prepared.headers };
    // After the signed headers; the owner's never touch webhook-*.
    for (const [name, value] of settings.ownerHeaders) headers[name] = value;
    return { outgoing: jsonForward(settings.url, headers, prepared.body) };
  }
  try {
    return {
      outgoing: buildRelay(request, {
        forwardUrl: settings.url,
        appendPath: settings.appendPath,
        slug: settings.slug,
        attempt: settings.attempt,
        secret: settings.secret,
        ownerHeaders: settings.ownerHeaders,
      }),
    };
  } catch (error) {
    // A captured path that would leave the owner's path (relay.ts): never sent.
    return { reason: error instanceof Error ? error.message : "The request cannot be forwarded." };
  }
}

function prepare(
  claim: Claim,
  request: RequestRecord,
  secret: string
): { outgoing: Outgoing } | { reason: string } {
  return outgoingFor(request, {
    url: claim.forward_url!,
    format: claim.forward_format,
    appendPath: claim.forward_append_path,
    slug: claim.endpoint_slug,
    name: claim.endpoint_name,
    showEmailExtracts: claim.show_email_extracts,
    ownerHeaders: claim.forward_headers_encrypted
      ? decryptOwnerHeaders(Buffer.from(claim.forward_headers_encrypted, "base64"))
      : [],
    attempt: claim.attempt,
    secret,
  });
}

/** Sends one claimed delivery and records the outcome. */
async function deliver(claim: Claim, request: RequestRecord | undefined): Promise<void> {
  // Deliveries that cannot be sent at all fail at once: retrying will not help.
  const giveUp = (reason: string) =>
    record(claim, { status: null, durationMs: 0, excerpt: null, error: reason }, false);
  if (!request) return giveUp("The request is no longer stored.");
  if (!claim.forward_url || !claim.forward_secret_encrypted) {
    return giveUp("Forwarding is not set up for this endpoint.");
  }
  let prepared: ReturnType<typeof prepare>;
  try {
    const secret = decryptSigningSecret(Buffer.from(claim.forward_secret_encrypted, "base64"));
    prepared = prepare(claim, request, secret);
  } catch (error) {
    // A server problem (SIGNING_SECRET_KEY missing or changed): retried on the
    // usual schedule, so deliveries resume once it is fixed.
    console.error("[forwarding] could not prepare delivery", claim.delivery_id, error);
    const result = {
      status: null,
      durationMs: 0,
      excerpt: null,
      error: "The delivery could not be signed on this server.",
    };
    return record(claim, result, true);
  }
  if ("reason" in prepared) return giveUp(prepared.reason);
  if ((prepared.outgoing.body?.byteLength ?? 0) > MAX_FORWARD_BYTES) {
    return giveUp("The request is too large to forward (over 10 MB).");
  }
  const result = await sendForward(prepared.outgoing, sendOptions());
  await record(claim, result, true);
}

/** Claims up to `limit` due deliveries, with the requests they forward. */
async function claimDeliveries(
  limit: number
): Promise<{ claims: Claim[]; requests: Map<string, RequestRecord> }> {
  const { data: claims, error } = await createAdminClient().rpc("claim_email_deliveries", {
    p_limit: limit,
    p_per_endpoint: PER_ENDPOINT,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw error;
  if (!claims || claims.length === 0) return { claims: [], requests: new Map() };
  const requests = await getRequestsByIds([...new Set(claims.map((claim) => claim.request_id))]);
  return { claims, requests: new Map(requests.map((request) => [request.id, request])) };
}

function deliverLogged(claim: Claim, request: RequestRecord | undefined): Promise<void> {
  return deliver(claim, request).catch((err) => {
    // The lease runs out and the delivery is claimed again.
    console.error("[forwarding] delivery", claim.delivery_id, "failed to record:", err);
  });
}

/** Claims up to `limit` due deliveries and sends them; resolves once all are recorded. */
export async function runForwardingBatch(limit: number = CONCURRENCY): Promise<number> {
  const { claims, requests } = await claimDeliveries(limit);
  await Promise.all(claims.map((claim) => deliverLogged(claim, requests.get(claim.request_id))));
  return claims.length;
}

const globalForWorker = globalThis as unknown as { __emailForwardingWorker?: NodeJS.Timeout };

/**
 * Starts the loop once per process. Each tick claims only for free slots and
 * does not wait for the sends, so a slow URL holds one slot, not the loop.
 */
export function startForwardingWorker(): void {
  if (globalForWorker.__emailForwardingWorker) return;
  let inFlight = 0;
  let claiming = false;
  let lastClaimAt = 0;
  let lastTickAt = 0;

  const tick = async () => {
    // Every BUSY_POLL_MS while deliveries were claimed lately, else every IDLE_POLL_MS.
    const now = Date.now();
    const busy = now - lastClaimAt < BUSY_FOR_MS;
    if (!busy && now - lastTickAt < IDLE_POLL_MS - BUSY_POLL_MS / 2) return;
    if (claiming || inFlight >= CONCURRENCY) return;
    lastTickAt = now;
    claiming = true;
    try {
      const { claims, requests } = await claimDeliveries(CONCURRENCY - inFlight);
      if (claims.length > 0) lastClaimAt = Date.now();
      for (const claim of claims) {
        inFlight++;
        void deliverLogged(claim, requests.get(claim.request_id)).finally(() => inFlight--);
      }
    } catch (error) {
      console.error("[forwarding] claim failed:", error);
    } finally {
      claiming = false;
    }
  };

  globalForWorker.__emailForwardingWorker = setInterval(() => void tick(), BUSY_POLL_MS);
  globalForWorker.__emailForwardingWorker.unref();
  void tick();
}
