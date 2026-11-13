import type { RequestCursor, RequestRecord } from "@/lib/supabase/requests";

/**
 * What an endpoint's live stream (`/api/stream/{slug}`) sends, and when.
 *
 * Realtime signals carry request ids only, so each signal triggers a read:
 *
 * 1. Forward, in (received_at, id) order, after the last row read. This is
 *    the backlog on connect and every new request after it.
 * 2. The signalled ids that read did not send. The receiver stamps
 *    received_at before the capture commits, so a capture that waited (for a
 *    capture slot, an email for its attachment upload) can commit after a
 *    newer one has gone out, behind the cursor where step 1 never looks. Ids
 *    are fetched in chunks and stay pending until their fetch succeeds, for
 *    a few tries.
 * 3. A look-back: the ids received in the last `lateWindowMs` up to the
 *    cursor, and the full rows of those not sent yet, for a capture behind
 *    the cursor whose signal Realtime dropped (at its rate limit) or this
 *    stream could not hold. It runs on every `recheck()` (the stream's
 *    look-back timer, every 10 s), and at most once per `recheckIntervalMs`
 *    for an overflow or a failed read. A capture stamped further back than
 *    the window (an email whose MX delivery was retried) relies on its
 *    signal alone.
 *
 * Every row is sent once (by id), and only rows received from
 * `afterTimestamp` on (the stream's `since`, or its start). A failed read is
 * tried again after `retryDelayMs`.
 */
export interface StreamDrainerDeps {
  afterTimestamp: number;
  /** Rows after `cursor` (or after `after` without one), oldest first; null when the endpoint is gone. */
  readAfter(input: {
    after: number;
    cursor: RequestCursor | null;
    limit: number;
  }): Promise<{ records: RequestRecord[]; cursor: RequestCursor | null } | null>;
  /** The endpoint's retained rows among `ids`. */
  readByIds(ids: string[]): Promise<RequestRecord[]>;
  /** Ids received after `from` (ms) and up to `to` (a stored received_at), at most `limit`. */
  readIdsInWindow(from: number, to: string, limit: number): Promise<string[]>;
  send(record: RequestRecord): void;
  /** The endpoint was deleted. */
  gone(): void;
  isClosed(): boolean;
  onError(error: unknown): void;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => void;
  pageSize?: number;
  lateWindowMs?: number;
  recheckIntervalMs?: number;
  retryDelayMs?: number;
  maxPendingSignals?: number;
  idChunkSize?: number;
  maxWindowIds?: number;
  maxFetchAttempts?: number;
}

export interface StreamDrainer {
  /** A `request_created` signal (with its id, when it carried one). */
  signal(id: string | null): void;
  /** Read again with the look-back (the stream's look-back timer). */
  recheck(): void;
  /** Read now; resolves when this read (and any it folded in) is done. */
  drain(): Promise<void>;
}

export function createStreamDrainer(deps: StreamDrainerDeps): StreamDrainer {
  const pageSize = deps.pageSize ?? 100;
  const lateWindowMs = deps.lateWindowMs ?? 60_000;
  const recheckIntervalMs = deps.recheckIntervalMs ?? 30_000;
  const retryDelayMs = deps.retryDelayMs ?? 2_000;
  const maxPending = deps.maxPendingSignals ?? 1000;
  const idChunkSize = deps.idChunkSize ?? 100;
  const maxWindowIds = deps.maxWindowIds ?? 5_000;
  const maxAttempts = deps.maxFetchAttempts ?? 3;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((run, ms) => void setTimeout(run, ms));

  // Sent ids and their received_at, pruned to the look-back window.
  const sent = new Map<string, number>();
  // Ids to fetch and how many fetches of them failed.
  const pending = new Map<string, number>();
  let cursor: RequestCursor | null = null;
  // A recheck()'s look-back always runs; an overflow's or a failure's at
  // most once per recheckIntervalMs.
  let recheckForced = false;
  let recheckWanted = false;
  let lastRecheck = Number.NEGATIVE_INFINITY;
  let retryScheduled = false;
  let running: Promise<void> | null = null;
  let again = false;

  const emit = (record: RequestRecord) => {
    // receivedAt is whole milliseconds and the reads compare microseconds,
    // so a row in the same millisecond as `afterTimestamp` is kept.
    if (deps.isClosed() || sent.has(record.id) || record.receivedAt < deps.afterTimestamp) {
      return;
    }
    sent.set(record.id, record.receivedAt);
    deps.send(record);
  };

  const failed = (error: unknown) => {
    recheckWanted = true;
    deps.onError(error);
    if (!retryScheduled && !deps.isClosed()) {
      retryScheduled = true;
      schedule(() => {
        retryScheduled = false;
        void drain();
      }, retryDelayMs);
    }
  };

  /** Forward from the cursor to the end; false when the endpoint is gone. */
  const readForward = async (): Promise<boolean> => {
    while (!deps.isClosed()) {
      const page = await deps.readAfter({ after: deps.afterTimestamp, cursor, limit: pageSize });
      if (page === null) {
        deps.gone();
        return false;
      }
      for (const record of page.records) {
        emit(record);
      }
      cursor = page.cursor;
      if (page.records.length < pageSize) break;
    }
    return true;
  };

  /** Fetches the pending ids not sent yet, chunk by chunk. */
  const fetchPending = async () => {
    for (const id of pending.keys()) {
      if (sent.has(id)) pending.delete(id);
    }
    const ids = [...pending.keys()];
    for (let i = 0; i < ids.length && !deps.isClosed(); i += idChunkSize) {
      const chunk = ids.slice(i, i + idChunkSize);
      try {
        const records = await deps.readByIds(chunk);
        for (const id of chunk) pending.delete(id);
        records.sort((a, b) => a.receivedAt - b.receivedAt).forEach(emit);
      } catch (error) {
        // Tried again next time, a few times; the look-back covers the rest.
        for (const id of chunk) {
          const attempts = (pending.get(id) ?? 0) + 1;
          if (attempts >= maxAttempts) pending.delete(id);
          else pending.set(id, attempts);
        }
        failed(error);
      }
    }
  };

  /** The look-back: ids behind the cursor, within the window, not sent yet. */
  const lookBack = async () => {
    const at = now();
    const due = recheckForced || (recheckWanted && at - lastRecheck >= recheckIntervalMs);
    if (!due || deps.isClosed()) return;
    recheckForced = false;
    recheckWanted = false;
    lastRecheck = at;
    if (!cursor) return; // Nothing behind a cursor yet: the forward read covers it all.
    const newest = Date.parse(cursor.receivedAt);
    const from = Math.max(deps.afterTimestamp, newest - lateWindowMs);
    const ids = await deps.readIdsInWindow(from, cursor.receivedAt, maxWindowIds);
    for (const id of ids) {
      if (!sent.has(id) && !pending.has(id)) pending.set(id, 0);
    }
    await fetchPending();
    // Rows older than the window are never read again but by a signal for
    // a new id, so their ids need not be kept.
    for (const [id, receivedAt] of sent) {
      if (receivedAt < from) sent.delete(id);
    }
  };

  const run = async (): Promise<void> => {
    do {
      again = false;
      try {
        if (!(await readForward())) return;
      } catch (error) {
        failed(error);
      }
      await fetchPending();
      try {
        await lookBack();
      } catch (error) {
        failed(error);
      }
    } while (again && !deps.isClosed());
  };

  const drain = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    signal(id) {
      if (id && (pending.has(id) || pending.size < maxPending)) {
        if (!sent.has(id) && !pending.has(id)) pending.set(id, 0);
      } else {
        // An id that cannot be held (or a signal without one) is found by
        // the look-back instead.
        recheckWanted = true;
      }
      void drain();
    },
    recheck() {
      recheckForced = true;
      void drain();
    },
    drain,
  };
}
