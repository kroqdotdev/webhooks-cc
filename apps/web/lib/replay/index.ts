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

/** Queues each request again; answers how many got at least one delivery. */
export async function replayRequests(endpointId: string, requestIds: string[]): Promise<number> {
  let queued = 0;
  for (const requestId of requestIds.slice(0, MAX_REPLAY)) {
    if (await queueRedelivery(requestId, endpointId)) queued++;
  }
  return queued;
}
