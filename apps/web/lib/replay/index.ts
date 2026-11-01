import { createAdminClient } from "@/lib/supabase/admin";
import { queueRedelivery } from "@/lib/supabase/forwarding";

/**
 * Replay: runs captured requests through the endpoint's destinations again,
 * with the endpoint's current settings (fields, templates, filters), after a
 * pattern was fixed or a destination came back. Each request is queued to
 * every destination that takes its kind, as a redelivery.
 */

/** Requests replayed in one call at most. */
export const MAX_REPLAY = 500;

export interface ReplayRange {
  /** Milliseconds; requests received at or after this. */
  since?: number | null;
  /** Milliseconds; requests received at or before this. */
  until?: number | null;
  kind?: "http" | "email" | null;
}

/** The ids of an endpoint's requests in a range, oldest first, at most MAX_REPLAY. */
export async function requestIdsInRange(endpointId: string, range: ReplayRange): Promise<string[]> {
  let query = createAdminClient()
    .from("requests")
    .select("id")
    .eq("endpoint_id", endpointId)
    .order("received_at", { ascending: true })
    .limit(MAX_REPLAY);
  // A bound of 0 is a bound (until: 0 replays nothing), not a missing one.
  if (range.since != null) query = query.gte("received_at", new Date(range.since).toISOString());
  if (range.until != null) query = query.lte("received_at", new Date(range.until).toISOString());
  if (range.kind) query = query.eq("kind", range.kind);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}

/**
 * Queues each request again; answers how many got at least one delivery (or,
 * for an email on an endpoint with layouts, a new parse, whose deliveries
 * follow as redeliveries). A re-parse reuses each attachment's stored parse,
 * so it uses no pages twice.
 */
export async function replayRequests(endpointId: string, requestIds: string[]): Promise<number> {
  const ids = requestIds.slice(0, MAX_REPLAY);
  if (ids.length === 0) return 0;
  const admin = createAdminClient();
  const { data: endpoint, error } = await admin
    .from("endpoints")
    .select("layouts")
    .eq("id", endpointId)
    .maybeSingle<{ layouts: unknown }>();
  if (error) throw error;
  const parses = Array.isArray(endpoint?.layouts) && endpoint.layouts.length > 0;
  const emails = new Set<string>();
  if (parses) {
    const { data, error: kindError } = await admin
      .from("requests")
      .select("id")
      .eq("endpoint_id", endpointId)
      .eq("kind", "email")
      .in("id", ids);
    if (kindError) throw kindError;
    for (const row of (data ?? []) as { id: string }[]) emails.add(row.id);
  }
  // An email still waiting for its parse gets its deliveries when that is
  // done; queueing them again here would send it twice.
  const { data: pending, error: pendingError } = await admin
    .from("request_parses")
    .select("request_id")
    .eq("status", "pending")
    .in("request_id", ids);
  if (pendingError) throw pendingError;
  for (const row of (pending ?? []) as { request_id: string }[]) emails.add(row.request_id);

  let queued = 0;
  for (const requestId of ids) {
    if (emails.has(requestId)) {
      const { data, error: redoError } = await admin.rpc("redo_request_parse", {
        p_request_id: requestId,
        p_deliver: true,
      });
      if (redoError) throw redoError;
      if (data) queued++;
    } else if (await queueRedelivery(requestId, endpointId)) {
      queued++;
    }
  }
  return queued;
}
