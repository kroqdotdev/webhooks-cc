import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability";
import { closeOnEdge } from "./edge";
import { STOPS } from "./stops";

/*
 * Access is checked when a run opens; this keeps a run from outliving it.
 * tunnel_runs_without_access() (migration 00091) finds the open runs whose
 * account is gone or suspended, whose key or agent registration was revoked,
 * whose live endpoint is gone or no longer reachable (unshared, a team left
 * or lapsed), whose team name the account may no longer use (a team left
 * or lapsed), or whose name staff blocked. The edge's sync runs it every
 * 30 seconds; the places that take access away run it at once, so the tunnel
 * closes without waiting for the next sync.
 */

const REASONS: Record<string, { record: string; tell: string }> = {
  "account deleted": STOPS.deleted,
  "sharing suspended": STOPS.suspended,
  "key revoked": STOPS.revoked,
  "endpoint deleted": STOPS.endpoint,
  "name blocked": STOPS.blocked,
  "access ended": STOPS.access,
};

/** Ends the open runs that lost their access; answers them with the words for the CLI. */
export async function endRunsWithoutAccess(): Promise<{ shareId: string; reason: string }[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("tunnel_runs_without_access");
  if (error) throw error;
  const lost = (data ?? []) as { id: string; reason: string }[];
  if (lost.length === 0) return [];
  const byReason = new Map<string, string[]>();
  for (const r of lost) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r.id]);
  const closed: { shareId: string; reason: string }[] = [];
  for (const [reason, ids] of byReason) {
    const stop = REASONS[reason] ?? STOPS.access;
    const { data: ended, error: endError } = await admin.rpc("tunnel_end_shares", {
      p_ids: ids,
      p_reason: stop.record,
    });
    if (endError) throw endError;
    for (const s of ended ?? []) closed.push({ shareId: s.id, reason: stop.tell });
  }
  return closed;
}

/**
 * After a change that takes access away: end what lost it and close it at the
 * edge now. Never throws; the next sync does the same if this fails.
 */
export async function closeRunsWithoutAccess(): Promise<void> {
  try {
    const closed = await endRunsWithoutAccess();
    if (closed.length > 0) await closeOnEdge(closed);
  } catch (err) {
    reportError("Failed to end tunnel runs that lost their access", err);
  }
}
