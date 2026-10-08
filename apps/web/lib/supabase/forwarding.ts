import { decryptSigningSecret, encryptSigningSecret } from "@/lib/crypto";
import { generateForwardSecret } from "@/lib/forwarding/sign";
import { createAdminClient } from "./admin";

/**
 * Email forwarding data for the routes: the endpoint's secret, the queue
 * (email_deliveries, migration 00050) and its attempts. The worker claims
 * and records deliveries through its own RPCs (lib/forwarding/worker.ts).
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
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  createdAt: number;
  finishedAt: number | null;
  /** When the next try is due, for pending deliveries. */
  nextAttemptAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  attemptLog: DeliveryAttempt[];
}

export interface RecentDelivery {
  id: string;
  requestId: string;
  status: Delivery["status"];
  attempts: number;
  createdAt: number;
  lastStatus: number | null;
  lastError: string | null;
  subject: string | null;
}

interface DeliveryRow {
  id: string;
  request_id: string;
  status: Delivery["status"];
  attempts: number;
  created_at: string;
  finished_at: string | null;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
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

/** Settles every pending delivery of an endpoint as failed, with `reason`. */
export async function settlePendingDeliveries(endpointId: string, reason: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("email_deliveries")
    .update({
      status: "failed",
      last_error: reason,
      finished_at: new Date().toISOString(),
      locked_until: null,
    })
    .eq("endpoint_id", endpointId)
    .eq("status", "pending");
  if (error) throw error;
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
      "id, request_id, status, attempts, created_at, finished_at, next_attempt_at, last_status, last_error"
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
    status: row.status,
    attempts: row.attempts,
    createdAt: millis(row.created_at) ?? 0,
    finishedAt: millis(row.finished_at),
    nextAttemptAt: row.status === "pending" ? millis(row.next_attempt_at) : null,
    lastStatus: row.last_status,
    lastError: row.last_error,
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

/** The endpoint's latest deliveries, for its Settings tab. */
export async function listRecentDeliveries(
  endpointId: string,
  limit = 5
): Promise<RecentDelivery[]> {
  const { data, error } = await createAdminClient()
    .from("email_deliveries")
    .select(
      "id, request_id, status, attempts, created_at, last_status, last_error, requests(subject:email->>subject)"
    )
    .eq("endpoint_id", endpointId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 20));
  if (error) throw error;
  return (data ?? []).map((row) => {
    const request = row.requests as unknown as { subject: string | null } | null;
    return {
      id: row.id,
      requestId: row.request_id,
      status: row.status,
      attempts: row.attempts,
      createdAt: millis(row.created_at) ?? 0,
      lastStatus: row.last_status,
      lastError: row.last_error,
      subject: request?.subject ?? null,
    };
  });
}

/** The newest email the endpoint captured, for a test delivery. */
export async function getNewestEmailRequestId(endpointId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("requests")
    .select("id")
    .eq("endpoint_id", endpointId)
    .eq("kind", "email")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}
