import { decryptSigningSecret } from "@/lib/crypto";
import { buildEmailJson } from "@webhooks-cc/sdk/email";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database";
import { getRequestsByIds, type RequestRecord } from "@/lib/supabase/requests";
import {
  chatPayload,
  CHAT_MESSAGE_CHARS,
  CHAT_PREVIEW_CHARS,
  isDiscordUrl,
  isSlackUrl,
  truncatePreview,
} from "./chat";
import { retryDelaySeconds } from "./schedule";
import { sendOptions } from "./config";
import { resolveFormat, type ForwardFormat } from "./format";
import { decryptOwnerHeaders } from "./owner-headers";
import { buildRelay, isoMillis, requestBodyBytes, type Outgoing } from "./relay";
import { buildRequestJson } from "./request-json";
import { isDelivered, jsonForward, sendForward, type SendResult } from "./send";
import { forwardHeaders, FORWARD_USER_AGENT } from "./sign";
import { senderTimestamp, type SenderTime } from "./timing";

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
/**
 * Chat webhooks take about one message a second (Slack) or a few every two
 * seconds per channel (Discord) and answer 429 above that, so messages to one
 * of them leave at most this often from this process.
 */
const SLACK_SPACING_MS = 1000;
const DISCORD_SPACING_MS = 2000;
/**
 * Deliveries waiting for one chat webhook's next slot in this process, and
 * the longest wait; past either, a delivery goes back to the queue instead
 * of holding a worker slot (one endpoint never has more in flight than
 * PER_ENDPOINT, so this only bites when several endpoints share a URL or
 * the URL asked us to back off).
 */
const MAX_CHAT_WAITERS = PER_ENDPOINT;
const MAX_CHAT_WAIT_MS = 10_000;
/** The longest Retry-After honoured. */
const MAX_RETRY_AFTER_SECONDS = 3600;

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

/** A captured HTTP request as signed JSON (request-json.ts). */
export function forwardRequestJson(
  request: RequestRecord,
  endpoint: { slug: string; name: string | null },
  secret: string
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(buildRequestJson(request, endpoint));
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
  now: number = Date.now(),
  retryAfterSeconds: number | null = null
): number | null {
  const scheduled = retryDelaySeconds(attempt);
  if (scheduled === null || windowSeconds <= 0) return null;
  // A throttled destination may ask for longer than the schedule (up to an hour), never shorter.
  const delay =
    retryAfterSeconds === null
      ? scheduled
      : Math.max(scheduled, Math.min(retryAfterSeconds, MAX_RETRY_AFTER_SECONDS));
  const queued = Date.parse(queuedAt);
  if (!Number.isFinite(queued)) return delay;
  return now + delay * 1000 <= queued + windowSeconds * 1000 ? delay : null;
}

/** How and where a delivery went, and the sender's own time, recorded with each try. */
export interface DeliveryFacts {
  format: ForwardFormat | null;
  /** The destination's host and path (host only for chat webhooks, whose path is the secret). */
  target: string | null;
  sent: SenderTime | null;
}

const NO_FACTS: DeliveryFacts = { format: null, target: null, sent: null };

/** Host and path of where a delivery goes, never the query or credentials. */
export function deliveryTarget(url: string, format: ForwardFormat): string | null {
  try {
    const parsed = new URL(url);
    if (format === "chat" || isSlackUrl(url) || isDiscordUrl(url)) return parsed.host;
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return null;
  }
}

async function record(
  claim: Claim,
  result: SendResult,
  retry: boolean,
  facts: DeliveryFacts = NO_FACTS
): Promise<void> {
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
        : nextRetry(
            claim.attempt,
            claim.queued_at,
            claim.forward_retry_seconds,
            Date.now(),
            result.status === 429 ? (result.retryAfterSeconds ?? null) : null
          ),
    p_format: facts.format,
    p_target: facts.target,
    p_sender_at: facts.sent ? new Date(facts.sent.at).toISOString() : null,
    p_sender_source: facts.sent?.source ?? null,
  });
  if (rpcError) throw rpcError;
}

/** A chat message for one captured request (format.ts picks this for Slack and Discord). */
export function chatForward(
  request: RequestRecord,
  slug: string,
  url: string,
  sent: SenderTime | null = null
): Outgoing {
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
    sent,
    receivedAtMs: request.receivedAt,
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
  /** endpoints.forward_sent_field: the body field with the sender's time. */
  sentField?: string | null;
}

/** The sender's own time for a request, as the dashboard reads it too (timing.ts). */
export function requestSenderTime(
  request: RequestRecord,
  sentField: string | null | undefined
): SenderTime | null {
  return senderTimestamp(
    {
      kind: request.kind,
      headers: request.headers,
      body: request.bodyRaw ? null : (request.body ?? null),
      emailDate: request.email?.date ?? null,
    },
    sentField
  );
}

/**
 * The outgoing request for one captured request with an endpoint's
 * forwarding settings, or why it cannot be sent at all, with the facts the
 * log records. Used by the worker and by the test delivery, so a test sends
 * what a real delivery would.
 */
export function outgoingFor(
  request: RequestRecord,
  settings: OutgoingSettings
): ({ outgoing: Outgoing } | { reason: string }) & { facts: DeliveryFacts } {
  const format = resolveFormat(request.kind, settings.format, settings.url);
  const facts: DeliveryFacts = {
    format,
    target: deliveryTarget(settings.url, format),
    sent: requestSenderTime(request, settings.sentField),
  };
  if (format === "chat") {
    return { outgoing: chatForward(request, settings.slug, settings.url, facts.sent), facts };
  }
  const hasOwnerHeaders = settings.ownerHeaders.length > 0;
  if (format === "json") {
    const endpoint = { slug: settings.slug, name: settings.name };
    const prepared =
      request.kind === "email"
        ? forwardRequest(request, endpoint, settings.secret, settings.showEmailExtracts)
        : forwardRequestJson(request, endpoint, settings.secret);
    if (!prepared) return { reason: "The email could not be read.", facts };
    const headers = { ...prepared.headers };
    // After the signed headers; the owner's never touch webhook-*.
    for (const [name, value] of settings.ownerHeaders) headers[name] = value;
    return {
      outgoing: jsonForward(settings.url, headers, prepared.body, {
        ownerHeaders: hasOwnerHeaders,
      }),
      facts,
    };
  }
  try {
    const outgoing = buildRelay(request, {
      forwardUrl: settings.url,
      appendPath: settings.appendPath,
      slug: settings.slug,
      attempt: settings.attempt,
      secret: settings.secret,
      ownerHeaders: settings.ownerHeaders,
    });
    return {
      outgoing,
      facts: { ...facts, target: deliveryTarget(outgoing.url, format) },
    };
  } catch (error) {
    // A captured path that would leave the owner's path (relay.ts): never sent.
    return {
      reason: error instanceof Error ? error.message : "The request cannot be forwarded.",
      facts,
    };
  }
}

function prepare(claim: Claim, request: RequestRecord, secret: string) {
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
    sentField: claim.forward_sent_field,
  });
}

/** When this process may next send to each chat webhook, and how many deliveries wait for it. */
const chatNextSendAt = new Map<string, number>();
const chatWaiters = new Map<string, number>();

function chatSpacing(url: string): number {
  return isSlackUrl(url) ? SLACK_SPACING_MS : isDiscordUrl(url) ? DISCORD_SPACING_MS : 0;
}

/**
 * Reserves the next slot for a message to a chat webhook: `wait` is how long
 * to wait before sending (0 for other destinations), or `retryInMs` when
 * enough deliveries already wait for this URL, or the wait is long (after a
 * 429), so the delivery should go back to the queue for that long instead.
 */
export function reserveChatSlot(
  url: string,
  now: number = Date.now()
): { wait: number } | { retryInMs: number } {
  const spacing = chatSpacing(url);
  if (spacing === 0) return { wait: 0 };
  const next = chatNextSendAt.get(url) ?? 0;
  const wait = Math.max(next - now, 0);
  if (wait > 0 && ((chatWaiters.get(url) ?? 0) >= MAX_CHAT_WAITERS || wait > MAX_CHAT_WAIT_MS)) {
    return { retryInMs: wait };
  }
  chatNextSendAt.set(url, Math.max(now, next) + spacing);
  if (chatNextSendAt.size > 1000) {
    for (const [key, value] of chatNextSendAt) {
      if (value < now && !chatWaiters.has(key)) chatNextSendAt.delete(key);
    }
  }
  return { wait };
}

/** After a 429, nothing goes to that chat webhook from this process until it said. */
export function holdChat(url: string, seconds: number, now: number = Date.now()): void {
  if (chatSpacing(url) === 0) return;
  const until = now + Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1000;
  chatNextSendAt.set(url, Math.max(chatNextSendAt.get(url) ?? 0, until));
}

async function waitForChatSlot(url: string, wait: number): Promise<void> {
  if (wait <= 0) return;
  chatWaiters.set(url, (chatWaiters.get(url) ?? 0) + 1);
  try {
    await new Promise((resolve) => setTimeout(resolve, wait));
  } finally {
    const left = (chatWaiters.get(url) ?? 1) - 1;
    if (left > 0) chatWaiters.set(url, left);
    else chatWaiters.delete(url);
  }
}

/** Puts a claimed delivery back without counting a try, due again in `delayMs`. */
async function release(claim: Claim, delayMs: number): Promise<void> {
  const { error } = await createAdminClient().rpc("release_email_delivery", {
    p_delivery_id: claim.delivery_id,
    p_attempt: claim.attempt,
    p_delay_ms: Math.ceil(delayMs),
  });
  if (error) throw error;
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
  let prepared: ReturnType<typeof outgoingFor>;
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
  const { facts } = prepared;
  const noResult = (reason: string) => ({
    status: null,
    durationMs: 0,
    excerpt: null,
    error: reason,
  });
  if ("reason" in prepared) return record(claim, noResult(prepared.reason), false, facts);
  if ((prepared.outgoing.body?.byteLength ?? 0) > MAX_FORWARD_BYTES) {
    return record(
      claim,
      noResult("The request is too large to forward (over 10 MB)."),
      false,
      facts
    );
  }
  const url = prepared.outgoing.url;
  if (facts.format === "chat") {
    const slot = reserveChatSlot(url);
    if ("retryInMs" in slot) return release(claim, slot.retryInMs);
    await waitForChatSlot(url, slot.wait);
  }
  const result = await sendForward(prepared.outgoing, sendOptions());
  if (facts.format === "chat" && result.status === 429) {
    holdChat(url, result.retryAfterSeconds ?? 1);
  }
  await record(claim, result, true, facts);
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
