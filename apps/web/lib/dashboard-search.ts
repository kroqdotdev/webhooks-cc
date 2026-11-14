/**
 * The dashboard's search over captured requests, as pure pieces the page puts
 * together: a search reads newest first within a time budget and answers how
 * far it got, so the list grows by pages ("Search older") and by arrivals
 * (only the range newer than what is shown), never by running it all again.
 */

/** Where a search stands: whether it read the whole range, and how to go on. */
export interface SearchProgress {
  complete: boolean;
  /** How far back it has read (epoch ms), when known. */
  searchedUntil: number | null;
  /** Continues the search with the same params; null when complete. */
  cursor: string | null;
}

export const SEARCH_NOT_STARTED: SearchProgress = {
  complete: true,
  searchedUntil: null,
  cursor: null,
};

/** A search page can continue only when it is incomplete and says how. */
export function canSearchOlder(progress: SearchProgress): boolean {
  return !progress.complete && progress.cursor !== null;
}

/**
 * Adds a page to the matches already shown: one row per id (the page's copy
 * wins, it is the fresher read), newest first.
 */
export function mergeSearchResults<T extends { id: string; receivedAt: number }>(
  existing: T[],
  incoming: T[]
): T[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, T>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  // Array.prototype.sort is stable, so equal times keep their order.
  return [...byId.values()].sort((a, b) => b.receivedAt - a.receivedAt);
}

/** The filters every page of one search shares. */
export function buildSearchParams({
  slug,
  query,
  methodFilter,
  kindFilter,
  limit,
}: {
  slug: string;
  query: string;
  methodFilter: string;
  kindFilter: string;
  limit: number;
}): Record<string, string> {
  const params: Record<string, string> = {
    slug,
    q: query,
    limit: String(limit),
    order: "desc",
  };
  if (methodFilter !== "ALL") params.method = methodFilter;
  if (kindFilter !== "all") params.kind = kindFilter;
  return params;
}

/**
 * Where a search for arrivals starts: the newest match shown, else the time
 * the search was anchored at. `from` is inclusive and `receivedAt` is
 * truncated to milliseconds, so the newest match comes back and is merged away.
 */
export function arrivalsFrom(results: { receivedAt: number }[], anchorMs: number): number {
  let newest = -Infinity;
  for (const result of results) {
    if (result.receivedAt > newest) newest = result.receivedAt;
  }
  return Math.floor(Number.isFinite(newest) ? Math.max(newest, anchorMs) : anchorMs);
}

/**
 * Hands out one AbortSignal at a time: starting the next aborts the one
 * before, so only the latest search's answer is waited for and read.
 */
export function createLatestOnly() {
  let controller: AbortController | null = null;
  return {
    /** Aborts whatever ran before and returns the signal for the new run. */
    start(): AbortSignal {
      controller?.abort();
      controller = new AbortController();
      return controller.signal;
    },
    /** Aborts the current run, if any. */
    abort(): void {
      controller?.abort();
      controller = null;
    },
  };
}

/**
 * Runs one task at a time. A request made while a task runs is not started
 * beside it and does not cut it short: it runs once the task has finished,
 * and several such requests become one run of the latest. Tasks must not
 * reject.
 */
export function createCoalescedRunner() {
  let running = false;
  let queued: (() => Promise<void>) | null = null;

  async function request(task: () => Promise<void>): Promise<void> {
    if (running) {
      queued = task;
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
      const next = queued;
      queued = null;
      if (next) void request(next);
    }
  }

  return {
    request,
    /** Forgets a request that has not started yet. */
    clear(): void {
      queued = null;
    },
  };
}

/** Why a search did not answer: the account's other searches, or anything else. */
export type SearchFailure = "busy" | "failed";
