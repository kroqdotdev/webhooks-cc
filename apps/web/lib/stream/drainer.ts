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
 *    stay pending until that fetch succeeds.
 * 3. On a recheck (the 30 s keepalive, a signal that overflowed the pending
 *    set, a failed read): the last `lateWindowMs` before the cursor again,
 *    for a capture behind it whose signal Realtime dropped.
 *
 * Every row is sent once (by id), and only rows received from
 * `afterTimestamp` on (the stream's `since`, or its start).
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
  send(record: RequestRecord): void;
  /** The endpoint was deleted. */
  gone(): void;
  isClosed(): boolean;
  onError(error: unknown): void;
  pageSize?: number;
  lateWindowMs?: number;
  maxPendingSignals?: number;
}

export interface StreamDrainer {
  /** A `request_created` signal (with its id, when it carried one). */
  signal(id: string | null): void;
  /** Read again, looking back over the late window too. */
  recheck(): void;
  /** Read now; resolves when this read (and any it folded in) is done. */
  drain(): Promise<void>;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_LATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_PENDING_SIGNALS = 1000;

export function createStreamDrainer(deps: StreamDrainerDeps): StreamDrainer {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const lateWindowMs = deps.lateWindowMs ?? DEFAULT_LATE_WINDOW_MS;
  const maxPending = deps.maxPendingSignals ?? DEFAULT_MAX_PENDING_SIGNALS;
  const sent = new Set<string>();
  const signalled = new Set<string>();
  let cursor: RequestCursor | null = null;
  let recheckDue = false;
  // The read in progress; a drain() meanwhile folds into it.
  let running: Promise<void> | null = null;
  let again = false;

  const emit = (record: RequestRecord) => {
    // receivedAt is whole milliseconds and the reads compare microseconds,
    // so a row in the same millisecond as `afterTimestamp` is kept.
    if (deps.isClosed() || sent.has(record.id) || record.receivedAt < deps.afterTimestamp) {
      return;
    }
    sent.add(record.id);
    deps.send(record);
  };

  /** Reads forward from `start` (or `after`) to the end; false when the endpoint is gone. */
  const readForward = async (
    after: number,
    start: RequestCursor | null
  ): Promise<{ ok: boolean; cursor: RequestCursor | null }> => {
    let position = start;
    while (!deps.isClosed()) {
      const page = await deps.readAfter({ after, cursor: position, limit: pageSize });
      if (page === null) {
        deps.gone();
        return { ok: false, cursor: position };
      }
      for (const record of page.records) {
        emit(record);
      }
      position = page.cursor;
      if (page.records.length < pageSize) break;
    }
    return { ok: true, cursor: position };
  };

  const run = async (): Promise<void> => {
    try {
      do {
        again = false;

        const forward = await readForward(deps.afterTimestamp, cursor);
        cursor = forward.cursor;
        if (!forward.ok) return;

        for (const id of signalled) {
          if (sent.has(id)) signalled.delete(id);
        }
        const late = [...signalled];
        if (late.length > 0 && !deps.isClosed()) {
          const records = await deps.readByIds(late);
          // Only once the read succeeded: a failed one keeps them pending.
          for (const id of late) signalled.delete(id);
          records.sort((a, b) => a.receivedAt - b.receivedAt).forEach(emit);
        }

        if (recheckDue && !deps.isClosed()) {
          recheckDue = false;
          const newest = cursor ? Date.parse(cursor.receivedAt) : deps.afterTimestamp;
          const from = Math.max(deps.afterTimestamp, newest - lateWindowMs);
          const window = await readForward(from, null);
          if (!window.ok) return;
        }
      } while (again && !deps.isClosed());
    } catch (error) {
      // What failed is read again next time, the late window included.
      recheckDue = true;
      deps.onError(error);
    }
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
      if (id && signalled.size < maxPending) {
        signalled.add(id);
      } else {
        // An id that cannot be held (or a signal without one) is found by
        // the late-window read instead.
        recheckDue = true;
      }
      void drain();
    },
    recheck() {
      recheckDue = true;
      void drain();
    },
    drain,
  };
}
