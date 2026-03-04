export function buildRetainedCountParams(
  slug: string,
  methodFilter: string,
  searchQuery: string
): Record<string, string> {
  const params: Record<string, string> = { slug };
  if (methodFilter !== "ALL") {
    params.method = methodFilter;
  }
  if (searchQuery) {
    params.q = searchQuery;
  }
  return params;
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
