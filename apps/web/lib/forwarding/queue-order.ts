/**
 * Puts claimed deliveries back in the order they were queued. A claim
 * function picks rows `order by created_at, id`, but it does so inside an
 * `update ... returning`, and Postgres keeps no order in what `returning`
 * hands back. Batches (Sheets appends, file drops) must still list requests
 * in the order they arrived.
 *
 * `queued_at` is the queue time plus the destination's delay, which is the
 * same for every row of one destination, so it sorts like `created_at`. It
 * is compared to the microsecond, as Postgres stores it, and ties fall back
 * to the id, as in the claim's own order.
 */
export function inQueueOrder<T extends { queued_at: string; delivery_id: string }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort(
    (a, b) =>
      compareTimestamps(a.queued_at, b.queued_at) ||
      (a.delivery_id < b.delivery_id ? -1 : a.delivery_id > b.delivery_id ? 1 : 0)
  );
}

/** Two Postgres timestamps (ISO 8601 with an offset) compared to the microsecond. */
function compareTimestamps(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b) || micros(a) - micros(b);
}

/** The digits past the millisecond, as a number of microseconds (0 to 999). */
function micros(value: string): number {
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  return Number(fraction.padEnd(6, "0").slice(3, 6));
}
