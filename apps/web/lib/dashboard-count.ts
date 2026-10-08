import { isEmailItem, type KindFilter } from "@/types/request";

export function buildRetainedCountParams(
  slug: string,
  methodFilter: string,
  searchQuery: string,
  toMs?: number,
  kindFilter: KindFilter = "all"
): Record<string, string> {
  const params: Record<string, string> = { slug };
  if (methodFilter !== "ALL") {
    params.method = methodFilter;
  }
  if (kindFilter !== "all") {
    params.kind = kindFilter;
  }
  if (searchQuery) {
    params.q = searchQuery;
  }
  if (toMs !== undefined) {
    params.to = String(toMs);
  }
  return params;
}

/**
 * Upper bound for a retained count that the dashboard keeps current in the
 * browser: the newest loaded request, plus 1 ms because `receivedAt` is
 * truncated to milliseconds while the database keeps microseconds.
 */
export function retainedCountCutoff(requests: { receivedAt: number }[]): number | undefined {
  return requests.length > 0 ? requests[0].receivedAt + 1 : undefined;
}

/** Whether a request passes the method and kind filters. */
export function matchesFilters(
  request: { method: string; kind?: "http" | "email" },
  methodFilter: string,
  kindFilter: KindFilter = "all"
): boolean {
  return (
    (methodFilter === "ALL" || request.method === methodFilter) &&
    (kindFilter === "all" || isEmailItem(request) === (kindFilter === "email"))
  );
}

/** Loaded requests newer than `afterMs` that pass the method and kind filters. */
export function countLoadedAfter(
  requests: { method: string; receivedAt: number; kind?: "http" | "email" }[],
  afterMs: number,
  methodFilter: string,
  kindFilter: KindFilter = "all"
): number {
  return requests.filter(
    (request) => request.receivedAt > afterMs && matchesFilters(request, methodFilter, kindFilter)
  ).length;
}

export function incrementRetainedCount(
  previousCount: number | null,
  matchedCount: number
): number | null {
  if (previousCount == null || matchedCount <= 0) {
    return previousCount;
  }
  return previousCount + matchedCount;
}

export function computeShowHasMore({
  searchQuery,
  hasMoreFromPagination,
  retainedTotalCount,
  loadedCount,
  hasLoadedOlderPage,
  initialCanLoadMore,
}: {
  searchQuery: string;
  hasMoreFromPagination: boolean;
  retainedTotalCount: number | null;
  loadedCount: number;
  hasLoadedOlderPage: boolean;
  initialCanLoadMore: boolean;
}): boolean {
  if (searchQuery) {
    return false;
  }
  if (hasMoreFromPagination) {
    return true;
  }
  if (retainedTotalCount != null) {
    return retainedTotalCount > loadedCount;
  }
  return !hasLoadedOlderPage && initialCanLoadMore;
}
