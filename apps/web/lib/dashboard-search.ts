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

/** A page's progress alone, without the requests it carried. */
export function progressOf(page: SearchProgress): SearchProgress {
  return { complete: page.complete, searchedUntil: page.searchedUntil, cursor: page.cursor };
}

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

/** Newest first reads back in time; oldest first reads forward. */
export type SearchOrder = "desc" | "asc";

/** What continuing a search is called, and how its reach reads, in each direction. */
export function searchWording(order: SearchOrder): {
  action: string;
  reached: string;
  unsearched: (noun: string) => string;
} {
  return order === "asc"
    ? {
        action: "Search newer",
        reached: "Searched up to",
        unsearched: (noun) => `Newer ${noun} not searched yet`,
      }
    : {
        action: "Search older",
        reached: "Searched back to",
        unsearched: (noun) => `Older ${noun} not searched yet`,
      };
}

/** How far a search read: the day and the minute, in the viewer's locale. */
export function formatSearchedUntil(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Newest first, arrivals could not all be read, so the top of the search was
 * read again (`fresh`, its first page). Everything from `coveredFrom` down
 * was already read as far as `existing` says. When the fresh page read down
 * to that point the two join and the older progress stands, with whatever
 * "Search older" loaded; when it stopped above it, requests between the two
 * are unread, so the search goes on from where the fresh page stopped (the
 * matches below stay shown and are merged by id when it reaches them).
 */
export function reconcileTopRefresh(
  existing: SearchProgress,
  fresh: SearchProgress,
  coveredFrom: number
): SearchProgress {
  if (fresh.complete) return progressOf(fresh);
  if (fresh.searchedUntil !== null && fresh.searchedUntil <= coveredFrom) return existing;
  return progressOf(fresh);
}

/** What an export gathered, and whether it holds everything that matches. */
export interface ExportRows<T> {
  rows: T[];
  /** The whole range was read. */
  complete: boolean;
  /** It stopped at the row limit rather than at the end of what it could read. */
  truncated: boolean;
  searchedUntil: number | null;
}

/**
 * Gathers an export by following the cursor until it has `maxRows`, the
 * range is read, or `maxPages` were fetched. A page with no rows that is not
 * complete is only a page whose time ran out, never a failure. A failure
 * after the first page keeps what was gathered; one on the first page throws.
 */
export async function collectExportRows<T extends { id: string }>(
  fetchPage: (cursor: string | null) => Promise<SearchProgress & { requests: T[] }>,
  { maxRows, maxPages }: { maxRows: number; maxPages: number }
): Promise<ExportRows<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let progress: SearchProgress = { complete: false, searchedUntil: null, cursor: null };
  let cursor: string | null = null;
  for (let fetched = 0; fetched < maxPages; fetched++) {
    let page: SearchProgress & { requests: T[] };
    try {
      page = await fetchPage(cursor);
    } catch (err) {
      if (fetched === 0) throw err;
      break;
    }
    for (const request of page.requests) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);
      rows.push(request);
    }
    progress = progressOf(page);
    if (rows.length >= maxRows || page.complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return {
    rows: rows.slice(0, maxRows),
    complete: progress.complete,
    truncated: rows.length >= maxRows && !progress.complete,
    searchedUntil: progress.searchedUntil,
  };
}

/** What to tell the person about an export that is not everything; null when it is. */
export function exportNotice(
  result: Omit<ExportRows<unknown>, "rows"> & { rows: { length: number } },
  formatTime: (timestamp: number) => string = formatSearchedUntil
): string | null {
  const count = result.rows.length;
  const reach =
    result.searchedUntil !== null ? `back to ${formatTime(result.searchedUntil)}` : "so far";
  if (count === 0) {
    return result.complete
      ? "Nothing to export: no requests match."
      : `Nothing to export yet: nothing matched in what was searched ${reach}. Older requests were not searched.`;
  }
  if (result.truncated) {
    return `Exported first ${count} requests. Use search filters to narrow the export.`;
  }
  if (!result.complete) {
    return `Exported ${count} request${count === 1 ? "" : "s"}: what was found searching ${reach}. Older requests were not searched.`;
  }
  return null;
}

/** The filters every page of one search shares. */
export function buildSearchParams({
  slug,
  query,
  methodFilter,
  kindFilter,
  limit,
  order = "desc",
}: {
  slug: string;
  query: string;
  methodFilter: string;
  kindFilter: string;
  limit: number;
  /** The way the list sorts: a search reads, and continues, in that direction. */
  order?: SearchOrder;
}): Record<string, string> {
  const params: Record<string, string> = {
    slug,
    q: query,
    limit: String(limit),
    order,
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
 * before, so only the latest search's answer is waited for, and the server
 * stops reading for an aborted one within a slice of its work.
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
