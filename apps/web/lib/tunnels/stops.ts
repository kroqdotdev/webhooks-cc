import { createAdminClient } from "@/lib/supabase/admin";
import { closeOnEdge } from "./edge";

/*
 * Stopping live runs on purpose: by their owner from the dashboard or through
 * the API (the SDK, a coding agent), by staff (a report, a blocked name, a
 * suspension), when a key is revoked, or in a team (someone in it stopped a
 * preview under the team's name). Each stop is recorded on the run, then sent
 * to the edge, which closes the tunnel and tells the CLI why; the CLI then
 * exits rather than reconnect.
 */

export const STOPS = {
  stopped: {
    record: "stopped",
    tell: "you stopped it on webhooks.cc",
    ending: "stopped from the dashboard",
  },
  api: {
    record: "stopped through the API",
    tell: "you stopped it through the webhooks.cc API (the SDK or a coding agent)",
    ending: "stopped through the API",
  },
  staff: {
    record: "stopped by webhooks.cc",
    tell: "webhooks.cc stopped it. Write to support@webhooks.cc if this is a mistake",
    ending: "stopped by webhooks.cc",
  },
  suspended: {
    record: "sharing suspended",
    tell: "sharing is suspended on this account. Write to support@webhooks.cc",
    ending: "sharing was suspended on the account",
  },
  deleted: {
    record: "account deleted",
    tell: "the account was deleted",
    ending: "the account was deleted",
  },
  revoked: {
    record: "key revoked",
    tell: "its API key was revoked. Run `whk auth login` to log in again",
    ending: "its API key was revoked",
  },
  blocked: {
    record: "name blocked",
    tell: "webhooks.cc blocked this name. Write to support@webhooks.cc if this is a mistake",
    ending: "webhooks.cc blocked the name",
  },
  team: {
    record: "stopped by the team",
    tell: "someone in your team stopped it on webhooks.cc",
    ending: "stopped by someone in your team",
  },
  access: {
    record: "access ended",
    tell: "the access it was opened with has ended (a team, a shared endpoint or an agent connection). Start it again if you still have access",
    ending: "the access it was opened with ended",
  },
} as const;

export type StopKind = keyof typeof STOPS;

/** How the other endings read on the Shares page. */
const OTHER_ENDINGS: Record<string, string> = {
  replaced: "replaced by a newer share under the same name",
  "time limit": "the plan's time limit was reached",
  "edge restart": "webhooks.cc restarted the tunnel service",
};

/** "the plan's time limit was reached", or null for a run its CLI ended. */
export function describeEnding(reason: string | null): string | null {
  if (!reason || reason === "closed") return null;
  const stop = Object.values(STOPS).find((s) => s.record === reason);
  return stop?.ending ?? OTHER_ENDINGS[reason] ?? reason;
}

/** What the CLI shows for a run that ended at the web app (sync). */
export function tellFor(reason: string | null): string {
  if (reason === "time limit") return "it reached the plan's time limit";
  const stop = Object.values(STOPS).find((s) => s.record === reason);
  return stop?.tell ?? "it ended on webhooks.cc";
}

/**
 * Endings a run may not come back from by reconnecting: every stop, and the
 * plan's time limit. A dropped tunnel, a restart or a newer run under the name
 * may.
 */
export const FINAL_ENDINGS: string[] = [...Object.values(STOPS).map((s) => s.record), "time limit"];

export type StopWhich =
  | { shareId: string; userId?: string }
  | { userId: string }
  | { keyId: string; userId: string }
  | { name: string };

export interface Stopped {
  /** Runs that were live and are now ended. */
  stopped: number;
  /** Whether the edge confirmed; if not, it closes them within 30 s. */
  edgeReached: boolean;
}

/** Ends the live runs chosen, records why, and closes them at the edge. */
export async function stopShares(which: StopWhich, kind: StopKind): Promise<Stopped> {
  const admin = createAdminClient();
  let query = admin.from("tunnel_shares").select("id").is("ended_at", null);
  if ("shareId" in which) {
    query = query.eq("id", which.shareId);
    if (which.userId) query = query.eq("user_id", which.userId);
  } else if ("keyId" in which) query = query.eq("key_id", which.keyId).eq("user_id", which.userId);
  else if ("userId" in which) query = query.eq("user_id", which.userId);
  else query = query.eq("name", which.name).eq("kind", "share");
  const { data: open, error } = await query;
  if (error) throw error;
  const ids = (open ?? []).map((s) => s.id);
  if (ids.length === 0) return { stopped: 0, edgeReached: true };

  const stop = STOPS[kind];
  const { data: ended, error: endError } = await admin.rpc("tunnel_end_shares", {
    p_ids: ids,
    p_reason: stop.record,
  });
  if (endError) throw endError;
  const closed = (ended ?? []).map((s) => ({ shareId: s.id, reason: stop.tell }));
  const edgeReached = await closeOnEdge(closed);
  return { stopped: closed.length, edgeReached };
}
