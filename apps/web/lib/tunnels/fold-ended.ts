import type { ShareRow } from "./shares";

/**
 * Ended runs, one per CLI run: the connections of a run that reconnected (same
 * instance) fold into one, from its first start to its last end, with the last
 * ending and the counts summed. Runs that reconnected and are live again are
 * left out (they show as live). Newest first, at most `limit`.
 */
export function foldEnded(
  ended: ShareRow[],
  liveInstances: Set<string>,
  limit: number
): ShareRow[] {
  const groups = new Map<string, ShareRow[]>();
  for (const r of ended) {
    const key = r.instance ? `${r.user_id}:${r.instance}` : r.id;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const folded: ShareRow[] = [];
  for (const [key, rows] of groups) {
    if (liveInstances.has(key)) continue;
    const last = rows.reduce((a, b) => ((b.ended_at ?? "") > (a.ended_at ?? "") ? b : a));
    const first = rows.reduce((a, b) => (b.started_at < a.started_at ? b : a));
    folded.push({
      ...last,
      started_at: first.started_at,
      bytes: rows.reduce((n, r) => n + Number(r.bytes), 0),
      requests: rows.reduce((n, r) => n + Number(r.requests), 0),
    });
  }
  return folded.sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? "")).slice(0, limit);
}
