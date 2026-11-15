/**
 * Where a replay batch ends. The query asks for one row more than the limit:
 * with that extra row there are more to come, and the batch ends before the
 * millisecond the extra row arrived in, which becomes the next call's
 * `since` (inclusive), so requests that share a millisecond are never split
 * between two calls and none is skipped.
 *
 * One exception: when more than `limit` requests share one millisecond, a
 * whole batch falls in it. The batch replays the first `limit` of them and
 * the next call starts at the millisecond after, so the extra ones in that
 * millisecond are skipped by the continuation (replay those one by one).
 */
export function cutAtLimit<T extends { received_at: string }>(
  rows: T[],
  limit: number
): { rows: T[]; nextSince: number | null } {
  if (rows.length <= limit) return { rows, nextSince: null };
  const next = Math.floor(Date.parse(rows[limit].received_at));
  let end = limit;
  while (end > 0 && Math.floor(Date.parse(rows[end - 1].received_at)) === next) end--;
  // A whole batch in one millisecond cannot end before it without replaying
  // nothing, again and again: replay the batch and go on after it.
  if (end === 0) return { rows: rows.slice(0, limit), nextSince: next + 1 };
  return { rows: rows.slice(0, end), nextSince: next };
}

/**
 * The `until` a replay applies: the one asked for, else the server's `now`,
 * so a call without one still has an end, which the answer names and a
 * continuation reuses, and requests captured after it never join the range.
 */
export function pinUntil(until: number | null | undefined, now: number = Date.now()): number {
  return until ?? now;
}
