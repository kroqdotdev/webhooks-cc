import { decryptSigningSecret } from "@/lib/crypto";
import { buildEmailJson } from "@/lib/email-json";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database";
import { getRequestsByIds, type RequestRecord } from "@/lib/supabase/requests";
import { retryDelaySeconds } from "./schedule";
import { sendOptions } from "./config";
import { isDelivered, sendForward, type SendResult } from "./send";
import { forwardHeaders } from "./sign";

/**
 * Sends forwarded email. capture_webhook() queues a delivery for every email
 * an endpoint with forwarding receives (migration 00050); this loop claims
 * due deliveries with a lease, sends each one's JSON (lib/email-json.ts)
 * signed with the endpoint's secret, and records the outcome, which
 * schedules the next try (schedule.ts) or settles the delivery.
 *
 * One loop per process, started from instrumentation.ts. Several processes
 * may run it: the claim never hands one delivery to two of them, and a
 * process that stops mid-send leaves a lease that runs out, so the delivery
 * is tried again later.
 */

const POLL_MS = 1000;
/** Deliveries in flight at once, per process. */
const CONCURRENCY = 8;
const PER_ENDPOINT = 2;
/** Longer than a send can take (FORWARD_TIMEOUT_MS plus the proxy's margin). */
const LEASE_SECONDS = 60;

type Claim = Database["public"]["Functions"]["claim_email_deliveries"]["Returns"][number];

/** The forwarded body and its signed headers for one email. */
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

async function record(claim: Claim, result: SendResult, retry: boolean): Promise<void> {
  const delivered = isDelivered(result);
  const error =
    result.error ?? (delivered ? null : `The URL answered ${result.status ?? "nothing"}.`);
  const { error: rpcError } = await createAdminClient().rpc("record_email_delivery_attempt", {
    p_delivery_id: claim.delivery_id,
    p_attempt: claim.attempt,
    p_succeeded: delivered,
    p_status: result.status,
    p_duration_ms: result.durationMs,
    p_error: error,
    p_response_excerpt: result.excerpt,
    p_retry_in_seconds: delivered || !retry ? null : retryDelaySeconds(claim.attempt),
  });
  if (rpcError) throw rpcError;
}

/** Sends one claimed delivery and records the outcome. */
async function deliver(claim: Claim, request: RequestRecord | undefined): Promise<void> {
  // Deliveries that cannot be sent at all fail at once: retrying will not help.
  const giveUp = (reason: string) =>
    record(claim, { status: null, durationMs: 0, excerpt: null, error: reason }, false);
  if (!request) return giveUp("The email is no longer stored.");
  if (!claim.forward_url || !claim.forward_secret_encrypted) {
    return giveUp("Forwarding is not set up for this endpoint.");
  }
  let prepared: ReturnType<typeof forwardRequest>;
  try {
    const secret = decryptSigningSecret(Buffer.from(claim.forward_secret_encrypted, "base64"));
    prepared = forwardRequest(
      request,
      { slug: claim.endpoint_slug, name: claim.endpoint_name },
      secret,
      claim.show_email_extracts
    );
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
  if (!prepared) return giveUp("Only emails are forwarded.");
  const result = await sendForward(
    claim.forward_url,
    prepared.headers,
    prepared.body,
    sendOptions()
  );
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

  const tick = async () => {
    if (claiming || inFlight >= CONCURRENCY) return;
    claiming = true;
    try {
      const { claims, requests } = await claimDeliveries(CONCURRENCY - inFlight);
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

  globalForWorker.__emailForwardingWorker = setInterval(() => void tick(), POLL_MS);
  globalForWorker.__emailForwardingWorker.unref();
  void tick();
}
