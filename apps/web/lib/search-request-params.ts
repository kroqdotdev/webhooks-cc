/**
 * What the two search routes (`/api/search/requests` and its `/count`) share:
 * reading time bounds, answering how far a search read, and reporting it.
 */

import { captureServerEvent } from "@/lib/analytics-server";

// The SDK's duration grammar (packages/sdk/src/utils.ts): "90s", "15m",
// "1h", "7d", "1.5h", "500ms".
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A `from` or `to` value: epoch milliseconds, or a duration meaning that long
 * before now ("1h" is an hour ago), which the CLI's `--from 1h` has always
 * sent. Returns undefined when absent and null when invalid.
 */
export function parseSearchTime(
  raw: string | null,
  now: number = Date.now()
): number | null | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isSafeInteger(ms) ? ms : null;
  }
  const match = DURATION.exec(value);
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  return Number.isFinite(ms) ? Math.max(0, Math.floor(now - ms)) : null;
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
  complete: boolean;
  slices: number;
  results: number;
  durationMs: number;
}

/**
 * One log line and one analytics event per search: how long it took, how far
 * it read and whether it finished, which is what decides whether search ever
 * needs an index. Never the term, the slug or results: those are captured
 * content.
 */
export function reportSearch(t: SearchTelemetry): void {
  const ms = Math.round(t.durationMs);
  console.info(
    "[search] kind=%s scoped=%s term=%s continued=%s complete=%s slices=%d results=%d ms=%d",
    t.kind,
    t.scoped,
    t.hasTerm,
    t.continued,
    t.complete,
    t.slices,
    t.results,
    ms
  );
  captureServerEvent({
    distinctId: t.userId,
    event: "request_search",
    properties: {
      kind: t.kind,
      scoped: t.scoped,
      has_term: t.hasTerm,
      continued: t.continued,
      complete: t.complete,
      slices: t.slices,
      duration_bucket: bucket(ms),
      duration_ms: ms,
    },
  });
}
