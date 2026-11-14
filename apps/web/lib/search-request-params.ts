/**
 * What the two search routes (`/api/search/requests` and its `/count`) share:
 * reading time bounds, answering how far a search read, and reporting it.
 */

import { randomUUID } from "node:crypto";
import { captureServerEvent } from "@/lib/analytics-server";
import { withSearchSlot } from "@/lib/search-gate";
import { cancelRequestSearch, LEGACY_SEARCH_BUDGET_MS, SEARCH_BUDGET_MS } from "@/lib/supabase/search";

// The SDK's duration grammar (packages/sdk/src/utils.ts): "90s", "15m",
// "1h", "7d", "1.5h", "500ms".
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// The latest time a JavaScript Date (and so every client) can name;
// later values would overflow the database's timestamps.
const MAX_TIME_MS = 8.64e15;

/** The longest term a search takes (characters). */
export const MAX_SEARCH_TERM_LENGTH = 1_000;

/**
 * A `from` or `to` value: epoch milliseconds (any non-negative number, as
 * the route always took, floored), or a duration meaning that long before
 * now ("1h" is an hour ago), which the CLI's `--from 1h` has always sent.
 * Returns undefined when absent or empty, and null when invalid.
 */
export function parseSearchTime(
  raw: string | null,
  now: number = Date.now()
): number | null | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;
  const match = DURATION.exec(value);
  if (match) {
    const ms = Number(match[1]) * UNIT_MS[match[2]];
    return Number.isFinite(ms) ? Math.max(0, Math.floor(now - ms)) : null;
  }
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(Math.floor(ms), MAX_TIME_MS);
}

/** Whether the caller pages with the cursor (`paged=true` or `paged=1`). */
export function isPagedSearch(searchParams: URLSearchParams): boolean {
  const value = searchParams.get("paged")?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * Runs one search for an account: in a search slot (see search-gate.ts),
 * with the budget the caller can use, and stopped in the database when the
 * caller goes away, since PostgREST would let it run to its budget. `run`
 * gets the budget and the cancel token to pass on.
 */
export async function runBoundedSearch<T>(input: {
  userId: string;
  signal: AbortSignal;
  paged: boolean;
  run: (options: { budgetMs: number; cancelToken: string }) => Promise<T>;
}): Promise<{ result: T; waitedMs: number; ranMs: number }> {
  const queued = performance.now();
  const cancelToken = randomUUID();
  const onAbort = () => {
    cancelRequestSearch(cancelToken).catch((error: unknown) => {
      console.warn(
        "[search] cancel failed:",
        error instanceof Error ? error.message : String(error)
      );
    });
  };
  let started = 0;
  const result = await withSearchSlot(
    input.userId,
    async () => {
      started = performance.now();
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await input.run({
          budgetMs: input.paged ? SEARCH_BUDGET_MS : LEGACY_SEARCH_BUDGET_MS,
          cancelToken,
        });
      } finally {
        input.signal.removeEventListener("abort", onAbort);
      }
    },
    { signal: input.signal }
  );
  return { result, waitedMs: started - queued, ranMs: performance.now() - started };
}

export interface SearchProgress {
  complete: boolean;
  searchedUntil: number | null;
  cursor: string | null;
}

/**
 * How far a search read, as headers: the list route keeps its array body for
 * existing clients, so this is where the page's state travels.
 */
export function applySearchProgressHeaders(response: Response, progress: SearchProgress): Response {
  response.headers.set("X-Search-Complete", progress.complete ? "true" : "false");
  if (progress.searchedUntil !== null) {
    response.headers.set("X-Search-Searched-Until", String(progress.searchedUntil));
  }
  if (progress.cursor) {
    response.headers.set("X-Search-Cursor", progress.cursor);
  }
  return response;
}

function bucket(ms: number): string {
  if (ms < 50) return "<50ms";
  if (ms < 250) return "50-250ms";
  if (ms < 1_000) return "250ms-1s";
  if (ms < 2_500) return "1-2.5s";
  return ">=2.5s";
}

export interface SearchTelemetry {
  userId: string;
  kind: "list" | "count";
  scoped: boolean;
  hasTerm: boolean;
  continued: boolean;
  paged: boolean;
  complete: boolean;
  slices: number;
  results: number;
  /** Time spent searching, after a slot was free. */
  durationMs: number;
  /** Time spent waiting for a slot. */
  waitedMs: number;
}

/**
 * One log line and one analytics event per search: how long it took, how far
 * it read and whether it finished, which is what decides whether search ever
 * needs an index. Never the term, the slug or results: those are captured
 * content.
 */
export function reportSearch(t: SearchTelemetry): void {
  const ms = Math.round(t.durationMs);
  const waited = Math.round(t.waitedMs);
  console.info(
    "[search] kind=%s scoped=%s term=%s continued=%s paged=%s complete=%s slices=%d results=%d ms=%d waited=%d",
    t.kind,
    t.scoped,
    t.hasTerm,
    t.continued,
    t.paged,
    t.complete,
    t.slices,
    t.results,
    ms,
    waited
  );
  captureServerEvent({
    distinctId: t.userId,
    event: "request_search",
    properties: {
      kind: t.kind,
      scoped: t.scoped,
      has_term: t.hasTerm,
      continued: t.continued,
      paged: t.paged,
      complete: t.complete,
      slices: t.slices,
      duration_bucket: bucket(ms),
      duration_ms: ms,
      waited_ms: waited,
    },
  });
}
