import { decryptSigningSecret } from "@/lib/crypto";
import { createHmac } from "node:crypto";
import {
  buildEmailJson,
  inboundEmailPayload,
  isInboundEmailFormat,
  type EmailField,
} from "@webhooks-cc/sdk/email";
import { emailFieldValues, storedEmailFields } from "@/lib/email-fields";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database";
import { getRequestsByIds, type RequestRecord } from "@/lib/supabase/requests";
import { renderJsonTemplate, renderTemplate, type Condition } from "@webhooks-cc/sdk";
import { templateContextFor, ruleSubjectFor } from "@/lib/request-context";
import { conditionsHold } from "@/lib/rules";
import type { Json } from "@/lib/supabase/database";
import {
  chatPayload,
  customChatPayload,
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
import { reportError } from "@/lib/observability";
import { withAttachmentPayloads } from "./attachments";
import { rowsFor, storedSheetsConfig } from "@/lib/integrations/sheets";
import {
  accessToken as googleAccessToken,
  appendRows,
  GoogleError,
  googleConfig,
} from "@/lib/integrations/google";
import { googleRefreshTokenById } from "@/lib/supabase/google-connections";
import { dropUrl, storedFileDropConfig, type FileDropConfig } from "@/lib/drops/config";
import { DropError, dropsOffered } from "@/lib/drops/connect";
import { dropFile, dropFileName, type DropFile } from "@/lib/drops/files";
import { openDropTarget, type DropTarget } from "@/lib/drops/target";
import { dropForDestination, pinDropHostKey } from "@/lib/supabase/destinations";

/**
 * Sends forwarded requests. capture_webhook() queues a delivery for every
 * captured request to every destination that takes its kind (migrations
 * 00050, 00058 and 00063); this loop claims due deliveries with a lease,
 * skips those the destination's filter turns down, sends each one in its
 * format (format.ts: an HTTP request as received, an email as signed JSON,
 * the owner's JSON template, either as a chat message to Slack or Discord)
 * and records the outcome, which schedules the next try (schedule.ts) within
 * the destination's retry window or settles the delivery.
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
/**
 * How often the loop says it is alive, with what it claimed since. A log
 * alert on this line going missing tells us the process stopped; a loop
 * whose claims stopped completing (a query that never returns) is an error.
 */
const HEARTBEAT_MS = 5 * 60_000;
const PER_ENDPOINT = 2;
/** Longer than a send can take (FORWARD_TIMEOUT_MS plus the proxy's margin). */
const LEASE_SECONDS = 60;
/** A Sheets batch is up to 50 rows in one append; its lease covers the token refresh and retries of the call. */
const SHEETS_LEASE_SECONDS = 180;
/** A file drop's lease, for the whole batch: connecting, logging in and writing up to 50 files or one batch file. */
const DROP_LEASE_SECONDS = 300;
/** The largest file a batch drop writes; what does not fit goes in the next one. */
const MAX_DROP_FILE_BYTES = 50 * 1024 * 1024;
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
  includeExtracts: boolean,
  fields: Record<string, string | null> | null = null
): { body: string; headers: Record<string, string> } | null {
  if (request.kind !== "email" || !request.email) return null;
  const body = JSON.stringify(
    buildEmailJson({ ...request, email: request.email }, endpoint, {
      includeExtracts,
      fields,
      parsed: request.parsed ?? null,
    })
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
  /** The destination's JSON body template (format "template"). */
  bodyTemplate?: Json | null;
  /** The destination's chat message template; null keeps the standard message. */
  messageTemplate?: string | null;
  /** The endpoint's named email fields, for templates, filters and the JSON. */
  emailFields?: readonly EmailField[];
  /** The owner's Mailgun signing key, for format "mailgun". */
  mailgunSigningKey?: string | null;
}

const hmacSha256Hex = (key: string, message: string) =>
  createHmac("sha256", key).update(message).digest("hex");

/** The most a template may produce; the notify proxy refuses larger bodies. */
const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;

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
  const endpoint = { slug: settings.slug, name: settings.name };
  const fields = emailFieldValues(request, settings.emailFields ?? []);
  if (isInboundEmailFormat(format)) {
    if (request.kind !== "email" || !request.email) {
      return { reason: "The email could not be read.", facts };
    }
    const payload = inboundEmailPayload(
      format,
      { ...request, email: request.email },
      {
        raw: request.bodyRaw ? null : (request.body ?? null),
        mailgunSigningKey: settings.mailgunSigningKey ?? null,
        hmacSha256Hex,
      }
    );
    // Signed like the JSON format too, so a handler can check it came from here.
    const headers: Record<string, string> = {
      ...forwardHeaders(settings.secret, request.id, payload.body),
      "content-type": payload.contentType,
    };
    for (const [name, value] of settings.ownerHeaders) headers[name] = value;
    return {
      outgoing: jsonForward(settings.url, headers, payload.body, {
        ownerHeaders: settings.ownerHeaders.length > 0,
      }),
      facts,
    };
  }
  if (format === "chat") {
    if (settings.messageTemplate) {
      const context = templateContextFor(request, endpoint, {
        includeExtracts: settings.showEmailExtracts,
        withSignature: true,
        fields,
      });
      const text = renderTemplate(settings.messageTemplate, context, {
        maxBytes: CHAT_MESSAGE_CHARS * 4,
      });
      if (!text.trim()) return { reason: "The message template came out empty.", facts };
      return {
        outgoing: jsonForward(
          settings.url,
          { "content-type": "application/json", "user-agent": FORWARD_USER_AGENT },
          JSON.stringify(customChatPayload(truncatePreview(text, CHAT_MESSAGE_CHARS), settings.url))
        ),
        facts,
      };
    }
    return { outgoing: chatForward(request, settings.slug, settings.url, facts.sent), facts };
  }
  const hasOwnerHeaders = settings.ownerHeaders.length > 0;
  if (format === "template") {
    if (settings.bodyTemplate === undefined || settings.bodyTemplate === null) {
      return { reason: "The destination has no template.", facts };
    }
    let body: string;
    try {
      const context = templateContextFor(request, endpoint, {
        includeExtracts: settings.showEmailExtracts,
        withSignature: true,
        fields,
      });
      body = JSON.stringify(
        renderJsonTemplate(settings.bodyTemplate, context, { maxBytes: MAX_TEMPLATE_BYTES })
      );
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : "The template could not be filled in.",
        facts,
      };
    }
    const headers = { ...forwardHeaders(settings.secret, request.id, body) };
    for (const [name, value] of settings.ownerHeaders) headers[name] = value;
    return {
      outgoing: jsonForward(settings.url, headers, body, { ownerHeaders: hasOwnerHeaders }),
      facts,
    };
  }
  if (format === "json") {
    const prepared =
      request.kind === "email"
        ? forwardRequest(request, endpoint, settings.secret, settings.showEmailExtracts, fields)
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
    bodyTemplate: claim.body_template,
    messageTemplate: claim.message_template,
    emailFields: storedEmailFields(claim.email_fields),
    mailgunSigningKey: claim.mailgun_key_encrypted
      ? decryptSigningSecret(Buffer.from(claim.mailgun_key_encrypted, "base64"))
      : null,
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

/**
 * The throttle of a destination with a filter, taken once the filter let a
 * delivery through (one without a filter is throttled when queued).
 */
async function takeSlot(claim: Claim): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("take_destination_slot", {
    p_destination_id: claim.destination_id,
  });
  if (error) throw error;
  return data === true;
}

function hasConditions(filter: Json | null): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false;
  const conditions = (filter as { conditions?: unknown }).conditions;
  return Array.isArray(conditions) && conditions.length > 0;
}

/**
 * A heads-up (a throttled destination that never retries) this late is not
 * sent: after an outage, or while chat spacing holds it, a burst of stale
 * heads-ups says nothing the first did not.
 */
export const HEADS_UP_MAX_LATE_MS = 60_000;

export function isStaleHeadsUp(
  claim: Pick<Claim, "throttle_seconds" | "forward_retry_seconds" | "queued_at" | "bypass_filter">,
  now: number = Date.now()
): boolean {
  return (
    claim.throttle_seconds > 0 &&
    claim.forward_retry_seconds === 0 &&
    !claim.bypass_filter &&
    now - Date.parse(claim.queued_at) > HEADS_UP_MAX_LATE_MS
  );
}

/** Puts a claimed delivery down as skipped: the destination's filter turned it down. */
async function skip(claim: Claim, reason: string): Promise<void> {
  const { error } = await createAdminClient().rpc("skip_email_delivery", {
    p_delivery_id: claim.delivery_id,
    p_attempt: claim.attempt,
    p_reason: reason,
  });
  if (error) throw error;
}

/** How long a filter on the signature waits for the receiver's check, which runs after the capture. */
const SIGNATURE_WAIT_MS = 30_000;

export type FilterVerdict = "send" | "skip" | { waitMs: number };

/**
 * Whether a destination's filter lets a request through. A filter that reads
 * the signature waits (up to 30 s after the capture) while the receiver's
 * check of a configured signature has not reported yet.
 */
export function filterVerdict(
  filter: Json | null,
  request: RequestRecord,
  signingProvider: string | null,
  now: number = Date.now(),
  fields: Record<string, string | null> | null = null
): FilterVerdict {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return "send";
  const group = filter as { logic?: unknown; conditions?: unknown };
  if (!Array.isArray(group.conditions) || group.conditions.length === 0) return "send";
  const conditions = group.conditions as unknown as Condition[];
  const readsSignature = conditions.some((condition) => condition.field === "signature");
  if (
    readsSignature &&
    signingProvider &&
    (request.signatureVerified === null || request.signatureVerified === undefined) &&
    !request.signatureError &&
    now - request.receivedAt < SIGNATURE_WAIT_MS
  ) {
    return { waitMs: 2000 };
  }
  return conditionsHold(
    { logic: group.logic === "or" ? "or" : "and", conditions },
    ruleSubjectFor(request, fields)
  )
    ? "send"
    : "skip";
}

/** A claimed delivery of a batch, with its request and named email fields. */
type BatchItem = {
  claim: Claim;
  request: RequestRecord;
  fields: Record<string, string | null> | null;
};

/** The Sheets rows of one delivery. */
type SheetsBatchItem = { claim: Claim; rows: string[][] };

/** Requests of a batch are loaded this many at a time (and the id list stays short in the URL). */
const BATCH_LOAD_CHUNK = 50;

/**
 * The deliveries of a batch that go out: the claimed one and the rows
 * claimed with it, each through its own filter and throttle (skipped,
 * released or failed here as a single delivery would be). Each admitted
 * delivery is handed to `onItem` as its chunk loads, so a large batch never
 * holds every request at once.
 */
async function admitBatch(
  claim: Claim,
  request: RequestRecord,
  more: Database["public"]["Functions"]["claim_destination_deliveries"]["Returns"],
  fail: (target: Claim, error: string, retry: boolean) => Promise<void>,
  onItem: (item: BatchItem) => Promise<void>
): Promise<void> {
  const extra = more.filter((row) => row.delivery_id !== claim.delivery_id);
  const fields = storedEmailFields(claim.email_fields);
  const admit = async (itemClaim: Claim, itemRequest: RequestRecord | undefined) => {
    if (!itemRequest) {
      await fail(itemClaim, "The request is no longer stored.", false);
      return;
    }
    const values = emailFieldValues(itemRequest, fields);
    if (!itemClaim.bypass_filter) {
      const verdict = filterVerdict(
        itemClaim.destination_filter,
        itemRequest,
        itemClaim.signing_provider,
        Date.now(),
        values
      );
      if (verdict === "skip") {
        await skip(itemClaim, "Not sent: the destination's filter did not match.");
        return;
      }
      if (verdict !== "send") {
        await release(itemClaim, verdict.waitMs);
        return;
      }
      // A destination without a filter took its slot when queueing.
      if (
        itemClaim.throttle_seconds > 0 &&
        hasConditions(itemClaim.destination_filter) &&
        !(await takeSlot(itemClaim))
      ) {
        await skip(
          itemClaim,
          `Not sent: at most one every ${itemClaim.throttle_seconds} s, and one went out less than that before.`
        );
        return;
      }
    }
    await onItem({ claim: itemClaim, request: itemRequest, fields: values });
  };

  await admit(claim, request);
  for (let start = 0; start < extra.length; start += BATCH_LOAD_CHUNK) {
    const chunk = extra.slice(start, start + BATCH_LOAD_CHUNK);
    const loaded = new Map(
      (await getRequestsByIds([...new Set(chunk.map((row) => row.request_id))])).map((r) => [
        r.id,
        r,
      ])
    );
    for (const row of chunk) {
      await admit(
        {
          ...claim,
          delivery_id: row.delivery_id,
          request_id: row.request_id,
          attempt: row.attempt,
          kind: row.kind,
          queued_at: row.queued_at,
          bypass_filter: row.bypass_filter,
        },
        loaded.get(row.request_id)
      );
    }
  }
}

/**
 * A Google Sheets destination: this delivery and up to 49 more of the same
 * destination that are due go out as one append (the Sheets API counts
 * calls, not rows), and each is recorded with the one outcome.
 */
async function deliverSheets(claim: Claim, request: RequestRecord): Promise<void> {
  const config = storedSheetsConfig(claim.destination_config);
  const google = googleConfig();
  const fail = (target: Claim, error: string, retry: boolean) =>
    record(target, { status: null, durationMs: 0, excerpt: null, error }, retry, {
      ...NO_FACTS,
      format: "sheets",
      target: "Google Sheets",
    });
  if (!config)
    return fail(claim, "The destination has no spreadsheet. Open it and choose one.", false);
  if (!google) return fail(claim, "Google Sheets is not set up on this server.", true);

  const { data: more, error } = await createAdminClient().rpc("claim_destination_deliveries", {
    p_destination_id: claim.destination_id!,
    p_limit: 49,
    p_lease_seconds: SHEETS_LEASE_SECONDS,
  });
  if (error) throw error;
  const endpoint = { slug: claim.endpoint_slug, name: claim.endpoint_name };
  const batch: SheetsBatchItem[] = [];
  await admitBatch(claim, request, more ?? [], fail, async (item) => {
    batch.push({
      claim: item.claim,
      rows: rowsFor(item.request, config, endpoint, {
        includeExtracts: item.claim.show_email_extracts,
        fields: item.fields,
      }),
    });
  });
  if (batch.length === 0) return;

  const started = performance.now();
  const facts: DeliveryFacts = { ...NO_FACTS, format: "sheets", target: "Google Sheets" };
  try {
    const { data: owner, error: ownerError } = await createAdminClient()
      .from("endpoints")
      .select("user_id")
      .eq("id", claim.endpoint_id)
      .maybeSingle<{ user_id: string | null }>();
    if (ownerError) throw ownerError;
    // Only the endpoint owner's own Google account writes its rows.
    const refreshToken = owner?.user_id
      ? await googleRefreshTokenById(config.connectionId, owner.user_id)
      : null;
    if (!refreshToken) {
      for (const item of batch) {
        await fail(item.claim, "The Google account was disconnected. Connect it again.", true);
      }
      return;
    }
    const token = await googleAccessToken(google, refreshToken);
    const rows = batch.flatMap((item) => item.rows);
    if (rows.length > 0) await appendRows(token, config.spreadsheetId, config.sheet, rows);
    const durationMs = Math.round(performance.now() - started);
    for (const item of batch) {
      await record(
        item.claim,
        {
          status: 200,
          durationMs,
          excerpt: `${item.rows.length} row${item.rows.length === 1 ? "" : "s"} added`,
          error: null,
        },
        true,
        facts
      );
    }
  } catch (sendError) {
    const message =
      sendError instanceof GoogleError
        ? sendError.reconnect
          ? "Google no longer accepts this connection. Connect the account again."
          : `Google Sheets: ${sendError.message}`
        : "Google Sheets could not be reached.";
    const status = sendError instanceof GoogleError ? sendError.status : null;
    const durationMs = Math.round(performance.now() - started);
    for (const item of batch) {
      await record(item.claim, { status, durationMs, excerpt: null, error: message }, true, facts);
    }
  }
}

/** What one delivery adds to a drop's file: rows (CSV, XML) or a document (JSON). */
async function dropContent(
  item: BatchItem,
  config: FileDropConfig,
  endpoint: { slug: string; name: string | null }
): Promise<{ rows: string[][]; document: unknown }> {
  const options = { includeExtracts: item.claim.show_email_extracts, fields: item.fields };
  if (config.file !== "json") {
    return { rows: rowsFor(item.request, config, endpoint, options), document: null };
  }
  // The JSON forwarding sends, with attachments as the destination carries them.
  const request = await withAttachmentPayloads(item.request, item.claim.attachments);
  const document =
    request.kind === "email" && request.email
      ? buildEmailJson({ ...request, email: request.email }, endpoint, {
          ...options,
          parsed: request.parsed ?? null,
        })
      : buildRequestJson(request, endpoint);
  return { rows: [], document };
}

/** Drops running at once in this process: a slow customer server must not hold every worker. */
const MAX_DROPS_IN_FLIGHT = 2;
let dropsInFlight = 0;
/** Every connection of one drop ends by then, well inside its lease. */
const DROP_DEADLINE_MS = 240_000;

/**
 * A file drop: this delivery and the others of the destination go out over
 * one connection, a file each (written as each is built), or (batch) one
 * file for everything that arrived while the batch collected. Each delivery
 * is recorded with the outcome of the file that holds it; a file is written
 * under a stable name, so a retry replaces it rather than adding another.
 */
async function deliverFileDrop(claim: Claim, request: RequestRecord): Promise<void> {
  const fail = (target: Claim, error: string, retry: boolean, facts: DeliveryFacts = NO_FACTS) =>
    record(target, { status: null, durationMs: 0, excerpt: null, error }, retry, {
      ...facts,
      format: "file_drop",
    });
  if (!dropsOffered()) return fail(claim, "File drops are not set up on this server.", true);
  if (dropsInFlight >= MAX_DROPS_IN_FLIGHT) return release(claim, 2000);
  dropsInFlight++;
  try {
    await runFileDrop(claim, request, fail);
  } finally {
    dropsInFlight--;
  }
}

async function runFileDrop(
  claim: Claim,
  request: RequestRecord,
  fail: (target: Claim, error: string, retry: boolean, facts?: DeliveryFacts) => Promise<void>
): Promise<void> {
  // The config and the secret from one read of the row: a secret is only
  // ever sent with the config it was saved for, whatever the claim carried.
  const row = await dropForDestination(claim.destination_id!);
  const config = row?.format === "file_drop" ? storedFileDropConfig(row.config) : null;
  if (!config) return fail(claim, "The drop has no settings. Open it and save them.", false);
  const facts: DeliveryFacts = { ...NO_FACTS, format: "file_drop", target: dropUrl(config) };
  const admin = createAdminClient();
  const { data: allowed, error: planError } = await admin.rpc("file_drops_allowed", {
    p_endpoint_id: claim.endpoint_id,
  });
  if (planError) throw planError;
  if (allowed !== true) {
    return skip(claim, "Not sent: file drops are part of Business, and paused on this plan.");
  }
  const secret = row!.secret;
  if (!secret) {
    return fail(claim, "The drop has no password or key. Open it and enter one.", false, facts);
  }

  // One lease for the whole batch, the delivery that started it included,
  // and one deadline inside it: what is not written by then waits for the
  // next try rather than outliving the lease (and being written twice).
  const deadlineAt = Date.now() + DROP_DEADLINE_MS;
  const pastDeadline = () => Date.now() >= deadlineAt;
  const { error: leaseError } = await admin
    .from("email_deliveries")
    .update({ locked_until: new Date(Date.now() + DROP_LEASE_SECONDS * 1000).toISOString() })
    .eq("id", claim.delivery_id)
    .eq("attempts", claim.attempt);
  if (leaseError) throw leaseError;
  const { data: more, error } = await admin.rpc(
    config.batch ? "claim_drop_batch" : "claim_destination_deliveries",
    {
      p_destination_id: claim.destination_id!,
      p_limit: config.batch ? 499 : 49,
      p_lease_seconds: DROP_LEASE_SECONDS,
    }
  );
  if (error) throw error;
  const endpoint = { slug: claim.endpoint_slug, name: claim.endpoint_name };
  const headers = config.columns.map((column) => column.header);
  const started = performance.now();
  const failed = async (claims: Claim[], dropError: unknown) => {
    const known = dropError instanceof DropError;
    if (!known) reportError("[drops] a drop failed unexpectedly", dropError);
    const message = known ? dropError.message : "The drop failed.";
    for (const target of claims) {
      await record(
        target,
        {
          status: null,
          durationMs: Math.round(performance.now() - started),
          excerpt: null,
          error: message,
        },
        known ? dropError.retry : true,
        facts
      );
    }
  };
  const succeeded = async (claims: Claim[], name: string) => {
    const durationMs = Math.round(performance.now() - started);
    for (const target of claims) {
      await record(
        target,
        { status: 200, durationMs, excerpt: `Wrote ${name}`, error: null },
        true,
        facts
      );
    }
  };

  // The connection opens with the first file to write; a failure to open
  // fails every delivery of the drop.
  let target: DropTarget | null = null;
  let openError: unknown = null;
  const connect = async (): Promise<DropTarget | null> => {
    if (target || openError) return target;
    try {
      target = await openDropTarget(config, secret, Math.max(deadlineAt - Date.now(), 1000));
      // The first SFTP connection pins the server's key, if the drop still
      // goes there and none was pinned meanwhile.
      if (config.protocol === "sftp" && !config.hostKey && target.hostKey) {
        await pinDropHostKey(
          claim.destination_id!,
          { host: config.host!, port: config.port!, username: config.username! },
          target.hostKey
        ).catch((pinError) =>
          // The files can still go: the key is pinned on a later connection.
          reportError("[drops] pinning a host key failed", pinError)
        );
      }
    } catch (connectError) {
      openError = connectError;
    }
    return target;
  };
  const write = async (file: DropFile, claims: Claim[]) => {
    const open = await connect();
    if (!open) return failed(claims, openError);
    try {
      await open.put(file.name, file.data, file.contentType);
    } catch (putError) {
      return failed(claims, putError);
    }
    await succeeded(claims, file.name);
  };
  const tooLarge = (claims: Claim[]) =>
    failed(
      claims,
      new DropError("This email is too large for a file drop (at most 50 MB a file).", false)
    );

  try {
    if (config.batch) {
      const held: Claim[] = [];
      const rows: string[][] = [];
      const documents: unknown[] = [];
      let first: RequestRecord | null = null;
      let size = 0;
      let full = false;
      await admitBatch(claim, request, more ?? [], fail, async (item) => {
        // The next batch takes what does not fit in this one, or comes after
        // the deadline, without building it.
        if (full || pastDeadline()) return release(item.claim, 0);
        const content = await dropContent(item, config, endpoint);
        const added = Buffer.byteLength(JSON.stringify(content));
        if (added > MAX_DROP_FILE_BYTES) return tooLarge([item.claim]);
        if (size + added > MAX_DROP_FILE_BYTES) {
          full = true;
          return release(item.claim, 0);
        }
        size += added;
        held.push(item.claim);
        first ??= item.request;
        rows.push(...content.rows);
        if (content.document !== null) documents.push(content.document);
      });
      if (held.length === 0 || !first) return;
      const firstRequest = first as RequestRecord;
      const file = dropFile(
        config.file,
        dropFileName(
          config.prefix,
          { id: firstRequest.id, receivedAt: new Date(firstRequest.receivedAt).toISOString() },
          config.file,
          true
        ),
        { headers, rows, documents, batch: true }
      );
      if (pastDeadline()) {
        for (const heldClaim of held) await release(heldClaim, 0);
        return;
      }
      await write(file, held);
    } else {
      await admitBatch(claim, request, more ?? [], fail, async (item) => {
        // Past the deadline, or the connection is gone: the rest waits for
        // the next try (a failure to connect fails them all, as it should).
        if (pastDeadline() && !openError) return release(item.claim, 0);
        const content = await dropContent(item, config, endpoint);
        const file = dropFile(
          config.file,
          dropFileName(
            config.prefix,
            { id: item.request.id, receivedAt: new Date(item.request.receivedAt).toISOString() },
            config.file,
            false
          ),
          {
            headers,
            rows: content.rows,
            documents: content.document === null ? [] : [content.document],
            batch: false,
          }
        );
        if (file.data.byteLength > MAX_DROP_FILE_BYTES) return tooLarge([item.claim]);
        await write(file, [item.claim]);
      });
    }
  } finally {
    const open = target as DropTarget | null;
    if (open) await open.close().catch(() => undefined);
  }
}

/** Sends one claimed delivery and records the outcome. */
async function deliver(claim: Claim, request: RequestRecord | undefined): Promise<void> {
  // Deliveries that cannot be sent at all fail at once: retrying will not help.
  const giveUp = (reason: string) =>
    record(claim, { status: null, durationMs: 0, excerpt: null, error: reason }, false);
  if (!request) return giveUp("The request is no longer stored.");
  if (!claim.forward_url) return giveUp("The destination has no URL.");
  if (claim.forward_format === "sheets") return deliverSheets(claim, request);
  if (claim.forward_format === "file_drop") return deliverFileDrop(claim, request);

  const verdict = claim.bypass_filter
    ? "send"
    : filterVerdict(
        claim.destination_filter,
        request,
        claim.signing_provider,
        Date.now(),
        emailFieldValues(request, storedEmailFields(claim.email_fields))
      );
  if (verdict === "skip") return skip(claim, "Not sent: the destination's filter did not match.");
  if (verdict !== "send") return release(claim, verdict.waitMs);
  if (isStaleHeadsUp(claim)) {
    return skip(claim, "Not sent: a heads-up that could not go out within a minute is dropped.");
  }
  if (
    claim.throttle_seconds > 0 &&
    !claim.bypass_filter &&
    hasConditions(claim.destination_filter) &&
    !(await takeSlot(claim))
  ) {
    return skip(
      claim,
      `Not sent: at most one every ${claim.throttle_seconds} s, and one went out less than that before.`
    );
  }

  const format = resolveFormat(request.kind, claim.forward_format, claim.forward_url);
  // Chat messages are not signed; every other format needs the secret.
  if (format !== "chat" && !claim.forward_secret_encrypted) {
    return giveUp("The destination has no signing secret. Open it and save it again.");
  }
  let prepared: ReturnType<typeof outgoingFor>;
  try {
    const secret = claim.forward_secret_encrypted
      ? decryptSigningSecret(Buffer.from(claim.forward_secret_encrypted, "base64"))
      : "";
    // Links or inline contents for a stored email's attachments; a storage
    // outage throws here and the delivery is retried on the usual schedule.
    const withAttachments = await withAttachmentPayloads(request, claim.attachments);
    prepared = prepare(claim, withAttachments, secret);
  } catch (error) {
    // A server problem (SIGNING_SECRET_KEY missing or changed): retried on the
    // usual schedule, so deliveries resume once it is fixed.
    reportError("[forwarding] could not prepare delivery", error, { delivery: claim.delivery_id });
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
    p_all: true,
  });
  if (error) throw error;
  if (!claims || claims.length === 0) return { claims: [], requests: new Map() };
  const requests = await getRequestsByIds([...new Set(claims.map((claim) => claim.request_id))]);
  return { claims, requests: new Map(requests.map((request) => [request.id, request])) };
}

function deliverLogged(claim: Claim, request: RequestRecord | undefined): Promise<void> {
  return deliver(claim, request).catch((err) => {
    // The lease runs out and the delivery is claimed again.
    reportError("[forwarding] delivery failed to record", err, { delivery: claim.delivery_id });
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
  let claimedSinceHeartbeat = 0;
  let lastClaimDoneAt = Date.now();

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
      lastClaimDoneAt = Date.now();
      if (claims.length > 0) lastClaimAt = lastClaimDoneAt;
      claimedSinceHeartbeat += claims.length;
      for (const claim of claims) {
        inFlight++;
        void deliverLogged(claim, requests.get(claim.request_id)).finally(() => inFlight--);
      }
    } catch (error) {
      reportError("[forwarding] claim failed", error);
    } finally {
      claiming = false;
    }
  };

  globalForWorker.__emailForwardingWorker = setInterval(() => void tick(), BUSY_POLL_MS);
  globalForWorker.__emailForwardingWorker.unref();
  setInterval(() => {
    if (Date.now() - lastClaimDoneAt > HEARTBEAT_MS) {
      reportError("[forwarding] no claim has completed in 5 minutes", undefined, {
        inFlight,
        claiming,
      });
    } else {
      console.info(`[forwarding] alive claimed=${claimedSinceHeartbeat} in_flight=${inFlight}`);
    }
    claimedSinceHeartbeat = 0;
  }, HEARTBEAT_MS).unref();
  void tick();
}
