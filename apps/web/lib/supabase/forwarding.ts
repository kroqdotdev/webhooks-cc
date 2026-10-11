import { decryptSigningSecret, encryptSigningSecret } from "@/lib/crypto";
import { decryptOwnerHeaders } from "@/lib/forwarding/owner-headers";
import { generateForwardSecret } from "@/lib/forwarding/sign";
import { createAdminClient } from "./admin";

/**
 * Forwarding data for the routes: the endpoint's secret and headers, the
 * queue (email_deliveries, migrations 00050 and 00058, which holds both kinds)
 * and its attempts. The worker claims and records deliveries through its own
 * RPCs (lib/forwarding/worker.ts).
 */

export interface DeliveryAttempt {
  attemptedAt: number;
  status: number | null;
  durationMs: number;
  error: string | null;
  responseExcerpt: string | null;
}

export interface Delivery {
  id: string;
  requestId: string;
  kind: "http" | "email";
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  createdAt: number;
  finishedAt: number | null;
  /** When the next try is due, for pending deliveries. */
  nextAttemptAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  /** How it went out (as_received, json, chat), recorded with the first try. */
  format: DeliveryFormat | null;
  /** The destination's host and path (host only for chat webhooks). */
  target: string | null;
  /** The sender's own timestamp and where it was read, when the request had one. */
  senderAt: number | null;
  senderSource: string | null;
  attemptLog: DeliveryAttempt[];
}

export type DeliveryFormat = "as_received" | "json" | "chat";

/** The log's filter: every delivery, those still waiting, or those that failed. */
export type DeliveryStatusFilter = "all" | "pending" | "failed";

export interface RecentDelivery {
  id: string;
  requestId: string;
  kind: Delivery["kind"];
  status: Delivery["status"];
  attempts: number;
  createdAt: number;
  /** When it was delivered or given up, null while pending. */
  finishedAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  /** The destination's time on the latest try. */
  lastDurationMs: number | null;
  /** What was forwarded: an email's subject, an HTTP request's method and path. */
  subject: string | null;
  method: string | null;
  path: string | null;
  /** When webhooks.cc received the request. */
  receivedAt: number | null;
  /** When the next try is due, for pending deliveries. */
  nextAttemptAt: number | null;
  format: DeliveryFormat | null;
  senderAt: number | null;
  senderSource: string | null;
  /** created_at at full precision: pass as `before` to load older rows. */
  cursor: string;
}

/** A cursor as listRecentDeliveries hands it out (a Postgres timestamp). */
export function isDeliveryCursor(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/.test(value);
}

export interface DeliverySummary {
  /** Among deliveries queued in the last 24 hours. */
  last24h: { delivered: number; failed: number };
  /** Waiting now: queued or retrying. */
  pending: number;
  /** Failed, among the deliveries still kept. */
  failed: number;
  total: number;
}

interface DeliveryRow {
  id: string;
  request_id: string;
  kind: Delivery["kind"];
  status: Delivery["status"];
  attempts: number;
  created_at: string;
  finished_at: string | null;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
  format: DeliveryFormat | null;
  target: string | null;
  sender_at: string | null;
  sender_source: string | null;
}

function millis(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Hex for PostgREST's bytea input. */
function byteaHex(bytes: Buffer): string {
  return `\\x${bytes.toString("hex")}`;
}

/** The plaintext forwarding secret of an endpoint the user owns, or null. */
export async function getForwardSecret(userId: string, slug: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("endpoints")
    .select("forward_secret_encrypted")
    .eq("user_id", userId)
    .eq("slug", slug.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  if (!data?.forward_secret_encrypted) return null;
  return decryptSigningSecret(
    Buffer.from(data.forward_secret_encrypted.replace(/^\\x/, ""), "hex")
  );
}

/** Replaces the secret; deliveries from now on are signed with the new one. */
export async function rotateForwardSecret(userId: string, slug: string): Promise<string | null> {
  const secret = generateForwardSecret();
  const { data, error } = await createAdminClient()
    .from("endpoints")
    .update({ forward_secret_encrypted: byteaHex(encryptSigningSecret(secret)) })
    .eq("user_id", userId)
    .eq("slug", slug.toLowerCase())
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data ? secret : null;
}

/**
 * Queues another delivery of one email, sent with the endpoint's current
 * settings. Null when forwarding is off (checked under the endpoint lock, so
 * a concurrent turn-off cannot leave the new row waiting).
 */
export async function queueRedelivery(
  requestId: string,
  endpointId: string
): Promise<string | null> {
  const { data, error } = await createAdminClient().rpc("queue_email_redelivery", {
    p_request_id: requestId,
    p_endpoint_id: endpointId,
  });
  if (error) throw error;
  return data ?? null;
}

/** Every delivery of one email, newest first, with its attempts. */
export async function listDeliveriesForRequest(requestId: string): Promise<Delivery[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_deliveries")
    .select(
      "id, request_id, kind, status, attempts, created_at, finished_at, next_attempt_at, last_status, last_error, format, target, sender_at, sender_source"
    )
    .eq("request_id", requestId)
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<DeliveryRow[]>();
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: attempts, error: attemptsError } = await admin
    .from("email_delivery_attempts")
    .select("delivery_id, attempted_at, status, duration_ms, error, response_excerpt")
    .in(
      "delivery_id",
      rows.map((row) => row.id)
    )
    .order("attempted_at", { ascending: false })
    .limit(200);
  if (attemptsError) throw attemptsError;

  return rows.map((row) => ({
    id: row.id,
    requestId: row.request_id,
    kind: row.kind ?? "email",
    status: row.status,
    attempts: row.attempts,
    createdAt: millis(row.created_at) ?? 0,
    finishedAt: millis(row.finished_at),
    nextAttemptAt: row.status === "pending" ? millis(row.next_attempt_at) : null,
    lastStatus: row.last_status,
    lastError: row.last_error,
    format: row.format,
    target: row.target,
    senderAt: millis(row.sender_at),
    senderSource: row.sender_source,
    attemptLog: (attempts ?? [])
      .filter((attempt) => attempt.delivery_id === row.id)
      .map((attempt) => ({
        attemptedAt: millis(attempt.attempted_at) ?? 0,
        status: attempt.status,
        durationMs: attempt.duration_ms,
        error: attempt.error,
        responseExcerpt: attempt.response_excerpt,
      })),
  }));
}

/**
 * The endpoint's deliveries, newest first, for its delivery log: all of them,
 * or only those waiting or failed, older than `before` (the cursor of the
 * last row shown) for "Show older".
 */
export async function listRecentDeliveries(
  endpointId: string,
  options: { limit?: number; status?: DeliveryStatusFilter; before?: string | null } = {}
): Promise<RecentDelivery[]> {
  const admin = createAdminClient();
  let query = admin
    .from("email_deliveries")
    .select(
      "id, request_id, kind, status, attempts, created_at, finished_at, next_attempt_at, last_status, last_error, format, sender_at, sender_source, requests(subject:email->>subject, method, path, received_at)"
    )
    .eq("endpoint_id", endpointId);
  if (options.status && options.status !== "all") query = query.eq("status", options.status);
  if (options.before && isDeliveryCursor(options.before)) {
    query = query.lt("created_at", options.before);
  }
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? 5, 1), 100));
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: attempts, error: attemptsError } = await admin
    .from("email_delivery_attempts")
    .select("delivery_id, attempted_at, duration_ms")
    .in(
      "delivery_id",
      rows.map((row) => row.id)
    )
    .order("attempted_at", { ascending: false })
    .limit(1000);
  if (attemptsError) throw attemptsError;
  const lastDuration = new Map<string, number>();
  for (const attempt of attempts ?? []) {
    if (!lastDuration.has(attempt.delivery_id)) {
      lastDuration.set(attempt.delivery_id, attempt.duration_ms);
    }
  }

  return rows.map((row) => {
    const request = row.requests as unknown as {
      subject: string | null;
      method: string | null;
      path: string | null;
      received_at: string | null;
    } | null;
    return {
      id: row.id,
      requestId: row.request_id,
      kind: (row.kind as RecentDelivery["kind"]) ?? "email",
      status: row.status,
      attempts: row.attempts,
      createdAt: millis(row.created_at) ?? 0,
      finishedAt: millis(row.finished_at),
      lastStatus: row.last_status,
      lastError: row.last_error,
      lastDurationMs: lastDuration.get(row.id) ?? null,
      subject: request?.subject ?? null,
      method: request?.method ?? null,
      path: request?.path ?? null,
      receivedAt: millis(request?.received_at ?? null),
      nextAttemptAt: row.status === "pending" ? millis(row.next_attempt_at) : null,
      format: (row.format as DeliveryFormat | null) ?? null,
      senderAt: millis(row.sender_at),
      senderSource: row.sender_source,
      cursor: row.created_at,
    };
  });
}

/** Counts for the Forwarding section's health line and the log's filters. */
export async function getDeliverySummary(
  endpointId: string,
  now: number = Date.now()
): Promise<DeliverySummary> {
  const { data, error } = await createAdminClient().rpc("delivery_summary", {
    p_endpoint_id: endpointId,
    p_since: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
  const row = data?.[0];
  return {
    last24h: { delivered: row?.delivered_recent ?? 0, failed: row?.failed_recent ?? 0 },
    pending: row?.pending ?? 0,
    failed: row?.failed ?? 0,
    total: row?.total ?? 0,
  };
}

/**
 * Queues every request whose latest delivery failed again, oldest first, up
 * to the pending cap; returns how many were queued (0 when forwarding is off).
 */
export async function queueFailedRedeliveries(endpointId: string): Promise<number> {
  const { data, error } = await createAdminClient().rpc("queue_failed_redeliveries", {
    p_endpoint_id: endpointId,
  });
  if (error) throw error;
  return data ?? 0;
}

/** The owner's forwarding headers in plain text, for a test delivery. */
export async function getForwardOwnerHeaders(
  userId: string,
  slug: string
): Promise<[string, string][]> {
  const { data, error } = await createAdminClient()
    .from("endpoints")
    .select("forward_headers_encrypted")
    .eq("user_id", userId)
    .eq("slug", slug.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  if (!data?.forward_headers_encrypted) return [];
  return decryptOwnerHeaders(
    Buffer.from(data.forward_headers_encrypted.replace(/^\\x/, ""), "hex")
  );
}

/** The newest email the endpoint captured, for a test delivery. */
export async function getNewestEmailRequestId(endpointId: string): Promise<string | null> {
  return getNewestRequestId(endpointId, "email");
}

/** The newest request of one kind the endpoint captured, for a test delivery. */
export async function getNewestRequestId(
  endpointId: string,
  kind: "http" | "email"
): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("requests")
    .select("id")
    .eq("endpoint_id", endpointId)
    .eq("kind", kind)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}
