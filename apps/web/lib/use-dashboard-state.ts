"use client";

import { useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { useSearchParams } from "next/navigation";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { DisplayableRequest } from "@/components/dashboard/request-detail";
import type { ClickHouseRequest, ClickHouseSummary, AnyRequestSummary } from "@/types/request";
import {
  buildRetainedCountParams,
  computeShowHasMore,
  incrementRetainedCount,
} from "@/lib/dashboard-count";
import { useDashboardStore } from "@/lib/dashboard-store";

const CLICKHOUSE_PAGE_SIZE = 50;

// Shorthand — reads latest state without subscribing to re-renders.
const getStore = () => useDashboardStore.getState();

// ── ClickHouse helpers (pure functions, no hooks) ─────────────────

async function fetchFromClickHouseImpl(
  authToken: string,
  params: Record<string, string>
): Promise<{ data: ClickHouseRequest[]; ok: boolean }> {
  try {
    const url = new URL("/api/search/requests", window.location.origin);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) return { data: [], ok: false };
    const results: unknown = await resp.json();
    if (!Array.isArray(results)) return { data: [], ok: false };
    if (results.length > 0) {
      const first = results[0] as Record<string, unknown>;
      if (
        typeof first.id !== "string" ||
        typeof first.method !== "string" ||
        typeof first.receivedAt !== "number"
      ) {
        console.error("ClickHouse response shape mismatch:", first);
        return { data: [], ok: false };
      }
    }
    return { data: results as ClickHouseRequest[], ok: true };
  } catch (err) {
    console.error("ClickHouse search failed:", err);
    return { data: [], ok: false };
  }
}

async function fetchCountImpl(
  authToken: string,
  params: Record<string, string>
): Promise<{ count: number | null; ok: boolean }> {
  try {
    const url = new URL("/api/search/requests/count", window.location.origin);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!resp.ok) return { count: null, ok: false };
    const data: unknown = await resp.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("count" in data) ||
      typeof (data as { count: unknown }).count !== "number"
    ) {
      return { count: null, ok: false };
    }
    return { count: (data as { count: number }).count, ok: true };
  } catch (err) {
    console.error("ClickHouse count failed:", err);
    return { count: null, ok: false };
  }
}

// ── Shared detail-fetch + cache logic ─────────────────────────────

interface MatchDetailOpts {
  id: string;
  slug: string;
  receivedAt?: number;
  summaryMethod?: string;
  detailMap: Map<string, ClickHouseRequest>;
  authToken: string;
}

/**
 * Fetch ClickHouse results around a timestamp and match the best result
 * to the given request id, caching it in detailMap.
 */
async function fetchAndCacheDetail(opts: MatchDetailOpts): Promise<ClickHouseRequest | undefined> {
  const params: Record<string, string> = {
    slug: opts.slug,
    limit: "10",
    order: "desc",
  };
  if (opts.receivedAt != null) {
    params.from = String(opts.receivedAt);
    params.to = String(opts.receivedAt);
  }

  const { data: results } = await fetchFromClickHouseImpl(opts.authToken, params);

  // Store all results in the cache
  for (const r of results) {
    opts.detailMap.set(r.id, r);
  }
  if (opts.detailMap.size > 500) {
    const excess = opts.detailMap.size - 500;
    const iter = opts.detailMap.keys();
    for (let i = 0; i < excess; i++) {
      const key = iter.next().value;
      if (key) opts.detailMap.delete(key);
    }
  }

  if (opts.receivedAt != null && results.length > 0) {
    const candidates = opts.summaryMethod
      ? results.filter((r) => r.method === opts.summaryMethod)
      : results;
    const pool = candidates.length > 0 ? candidates : results;
    const match = pool.reduce((best, r) =>
      Math.abs(r.receivedAt - opts.receivedAt!) < Math.abs(best.receivedAt - opts.receivedAt!)
        ? r
        : best
    );
    opts.detailMap.set(opts.id, match);
    return match;
  } else if (results.length > 0) {
    const match = results.find((r) => r.id === opts.id);
    if (match) {
      opts.detailMap.set(opts.id, match);
      return match;
    }
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════════

export function useDashboardState() {
  // ── Fine-grained Zustand subscriptions for values the UI reads ──
  // Actions are stable references from the store — access via getStore().
  const selectedId = useDashboardStore((s) => s.selectedId);
  const selectedDetail = useDashboardStore((s) => s.selectedDetail);
  const mobileDetail = useDashboardStore((s) => s.mobileDetail);
  const liveMode = useDashboardStore((s) => s.liveMode);
  const sortNewest = useDashboardStore((s) => s.sortNewest);
  const newCount = useDashboardStore((s) => s.newCount);
  const methodFilter = useDashboardStore((s) => s.methodFilter);
  const searchInput = useDashboardStore((s) => s.searchInput);
  const debouncedSearch = useDashboardStore((s) => s.debouncedSearch);
  const olderRequests = useDashboardStore((s) => s.olderRequests);
  const searchResults = useDashboardStore((s) => s.searchResults);
  const hasMore = useDashboardStore((s) => s.hasMore);
  const hasLoadedOlderPage = useDashboardStore((s) => s.hasLoadedOlderPage);
  const retainedTotalCount = useDashboardStore((s) => s.retainedTotalCount);
  const loadingMore = useDashboardStore((s) => s.loadingMore);
  const searchLoading = useDashboardStore((s) => s.searchLoading);
  const searchError = useDashboardStore((s) => s.searchError);

  // ── Convex queries (must be React hooks) ────────────────────────
  const endpoints = useQuery(api.endpoints.list);
  const searchParams = useSearchParams();
  const endpointSlug = searchParams.get("endpoint");

  const currentEndpoint = endpoints?.find((ep) => ep.slug === endpointSlug) ?? endpoints?.[0];

  const summaries = useQuery(
    api.requests.listSummaries,
    currentEndpoint ? { endpointId: currentEndpoint._id, limit: 50 } : "skip"
  );

  const isConvexId = selectedId != null && !selectedId.includes(":");
  const selectedRequest = useQuery(
    api.requests.get,
    isConvexId && !selectedDetail
      ? { id: selectedId as Id<"requests"> }
      : "skip"
  );

  // ── Auth token ──────────────────────────────────────────────────
  const authToken = useAuthToken();

  // ── Reset store on unmount (fixes stale state on re-navigation) ─
  useEffect(() => {
    return () => {
      getStore().reset();
    };
  }, []);

  // ── Debounce search ─────────────────────────────────────────────
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (searchInput === "") {
      getStore().setDebouncedSearch("");
      return;
    }
    searchDebounceRef.current = setTimeout(
      () => getStore().setDebouncedSearch(searchInput),
      400
    );
    return () => clearTimeout(searchDebounceRef.current);
  }, [searchInput]);

  // ── Clear stale selection ───────────────────────────────────────
  useEffect(() => {
    if (selectedRequest === null && !selectedDetail && selectedId && isConvexId) {
      getStore().setSelectedId(null);
    }
  }, [selectedRequest, selectedDetail, selectedId, isConvexId]);

  // ── Displayable request ─────────────────────────────────────────
  const displayRequest = useMemo((): DisplayableRequest | undefined => {
    if (!selectedId) return undefined;
    if (selectedDetail) return selectedDetail;
    if (isConvexId) return selectedRequest ?? undefined;
    return undefined;
  }, [selectedId, selectedDetail, isConvexId, selectedRequest]);

  // ── Detail cache ────────────────────────────────────────────────
  const clickHouseDetailMap = useRef(new Map<string, ClickHouseRequest>());

  // ── Pre-fetch first ClickHouse page ─────────────────────────────
  const prefetchedSlug = useRef<string | null>(null);
  useEffect(() => {
    if (!currentEndpoint || !summaries?.length || !authToken) return;
    if (prefetchedSlug.current === currentEndpoint.slug) return;

    const slugToFetch = currentEndpoint.slug;
    let cancelled = false;

    fetchFromClickHouseImpl(authToken, { slug: slugToFetch, limit: "50", order: "desc" }).then(
      ({ data: results }) => {
        if (cancelled) return;
        prefetchedSlug.current = slugToFetch;
        const map = clickHouseDetailMap.current;
        for (const r of results) map.set(r.id, r);
        const consumed = new Set<string>();
        for (const summary of summaries) {
          const match = results.find(
            (r) =>
              !consumed.has(r.id) &&
              r.method === summary.method &&
              Math.abs(r.receivedAt - summary.receivedAt) < 2
          );
          if (match) {
            consumed.add(match.id);
            map.set(summary._id, match);
          }
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [currentEndpoint, summaries, authToken]);

  // ── Fetch detail on selection change ────────────────────────────
  useEffect(() => {
    if (!selectedId) {
      getStore().setSelectedDetail(null);
      return;
    }

    const cached = clickHouseDetailMap.current.get(selectedId);
    if (cached) {
      getStore().setSelectedDetail(cached);
      return;
    }

    getStore().setSelectedDetail(null);
    if (!currentEndpoint || !authToken) return;

    let receivedAt: number | undefined;
    if (isConvexId && summaries) {
      const summary = summaries.find((s) => s._id === selectedId);
      if (summary) receivedAt = summary.receivedAt;
    }

    if (isConvexId && receivedAt == null) {
      return;
    }

    const summaryMethod = summaries?.find((s) => s._id === selectedId)?.method;
    let cancelled = false;

    fetchAndCacheDetail({
      id: selectedId,
      slug: currentEndpoint.slug,
      receivedAt,
      summaryMethod,
      detailMap: clickHouseDetailMap.current,
      authToken,
    }).then((match) => {
      if (cancelled) return;
      getStore().setSelectedDetail(match ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedId, isConvexId, currentEndpoint, summaries, authToken]);

  // ── Clear paginated results on filter change ────────────────────
  const prevMethodFilter = useRef(methodFilter);
  useEffect(() => {
    if (prevMethodFilter.current !== methodFilter) {
      prevMethodFilter.current = methodFilter;
      const s = getStore();
      s.setOlderRequests([]);
      s.setHasMore(false);
      s.setHasLoadedOlderPage(false);
    }
  }, [methodFilter]);

  // ── Load More ───────────────────────────────────────────────────
  const handleLoadMore = useCallback(async () => {
    const s = getStore();
    if (!currentEndpoint || !authToken || s.loadingMore) return;
    s.setLoadingMore(true);

    const currentOldest =
      s.olderRequests.length > 0 ? s.olderRequests[s.olderRequests.length - 1] : null;
    const oldestFromSummaries =
      summaries && summaries.length > 0 ? summaries[summaries.length - 1] : null;

    const toTimestamp = currentOldest
      ? currentOldest.receivedAt
      : oldestFromSummaries
        ? oldestFromSummaries.receivedAt
        : undefined;

    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: String(CLICKHOUSE_PAGE_SIZE),
      order: "desc",
    };
    if (s.methodFilter !== "ALL") params.method = s.methodFilter;
    if (toTimestamp != null) params.to = String(Math.floor(toTimestamp) - 1);

    try {
      const { data: results } = await fetchFromClickHouseImpl(authToken, params);
      const map = clickHouseDetailMap.current;
      for (const r of results) map.set(r.id, r);
      const s2 = getStore();
      s2.setOlderRequests((prev) => [...prev, ...results]);
      s2.setHasMore(results.length >= CLICKHOUSE_PAGE_SIZE);
      s2.setHasLoadedOlderPage(true);
    } catch (err) {
      console.error("Load more failed:", err);
    } finally {
      getStore().setLoadingMore(false);
    }
  }, [currentEndpoint, summaries, authToken]);

  // ── Search via ClickHouse ───────────────────────────────────────
  useEffect(() => {
    if (!debouncedSearch || !currentEndpoint || !authToken) {
      const s = getStore();
      s.setSearchResults([]);
      s.setSearchError(false);
      s.setSearchLoading(false);
      return;
    }

    let cancelled = false;
    getStore().setSearchLoading(true);
    getStore().setSearchError(false);

    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      q: debouncedSearch,
      limit: String(CLICKHOUSE_PAGE_SIZE),
      order: "desc",
    };
    if (methodFilter !== "ALL") params.method = methodFilter;

    fetchFromClickHouseImpl(authToken, params)
      .then(({ data: results, ok }) => {
        if (cancelled) return;
        if (!ok) {
          getStore().setSearchError(true);
          getStore().setSearchResults([]);
        } else {
          const map = clickHouseDetailMap.current;
          for (const r of results) map.set(r.id, r);
          getStore().setSearchResults(results);
        }
      })
      .finally(() => {
        if (!cancelled) getStore().setSearchLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, currentEndpoint, methodFilter, authToken]);

  // ── Retained count ──────────────────────────────────────────────
  const currentSlug = currentEndpoint?.slug;
  const retainedCountRequestSeq = useRef(0);

  const refreshRetainedCount = useCallback(async () => {
    if (!currentSlug || !authToken) return;
    const requestSeq = ++retainedCountRequestSeq.current;
    const { methodFilter: mf, debouncedSearch: ds } = getStore();
    const params = buildRetainedCountParams(currentSlug, mf, ds);

    const { count, ok } = await fetchCountImpl(authToken, params);
    if (requestSeq !== retainedCountRequestSeq.current) return;
    if (ok && count != null) {
      getStore().setRetainedTotalCount(count);
    }
  }, [currentSlug, authToken]);

  useEffect(() => {
    if (!currentSlug || !authToken) {
      retainedCountRequestSeq.current++;
      getStore().setRetainedTotalCount(null);
      return;
    }
    void refreshRetainedCount();
  }, [currentSlug, authToken, methodFilter, debouncedSearch, refreshRetainedCount]);

  // Re-sync count on tab focus
  useEffect(() => {
    if (!currentSlug || !authToken) return;
    const onFocus = () => void refreshRetainedCount();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshRetainedCount();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [currentSlug, authToken, refreshRetainedCount]);

  // ── Displayed items ─────────────────────────────────────────────
  const displayedItems = useMemo((): AnyRequestSummary[] => {
    if (debouncedSearch) {
      return searchResults.map(
        (r): ClickHouseSummary => ({
          id: r.id,
          method: r.method,
          receivedAt: r.receivedAt,
        })
      );
    }

    const convexSummaries: AnyRequestSummary[] = summaries
      ? methodFilter === "ALL"
        ? summaries
        : summaries.filter((r) => r.method === methodFilter)
      : [];

    const oldestConvex =
      summaries && summaries.length > 0
        ? summaries[summaries.length - 1].receivedAt
        : -Infinity;
    const olderSummaries: ClickHouseSummary[] = olderRequests
      .filter((r) => r.receivedAt < oldestConvex)
      .map((r) => ({ id: r.id, method: r.method, receivedAt: r.receivedAt }));

    return [...convexSummaries, ...olderSummaries];
  }, [summaries, olderRequests, searchResults, debouncedSearch, methodFilter]);

  // ── Live mode tracking ──────────────────────────────────────────
  const prevTopSummaryId = useRef<string | null>(null);
  useEffect(() => {
    if (!summaries || summaries.length === 0) {
      prevTopSummaryId.current = null;
      return;
    }

    const topId = summaries[0]._id;
    const previousTopId = prevTopSummaryId.current;

    if (previousTopId && topId !== previousTopId) {
      const previousIdx = summaries.findIndex((s) => s._id === previousTopId);
      const arrived = previousIdx >= 0 ? previousIdx : 1;

      if (arrived > 0) {
        const s = getStore();
        if (s.liveMode) {
          s.setSelectedId(topId);
        } else {
          s.setNewCount((prev) => prev + arrived);
        }

        if (!s.debouncedSearch) {
          const newRows = summaries.slice(0, arrived);
          const matchedCount =
            s.methodFilter === "ALL"
              ? arrived
              : newRows.filter((r) => r.method === s.methodFilter).length;
          if (matchedCount > 0) {
            s.setRetainedTotalCount((prev) => incrementRetainedCount(prev, matchedCount));
          }
        }

        if (previousIdx === -1) {
          void refreshRetainedCount();
        }
      }
    }

    prevTopSummaryId.current = topId;
  }, [summaries, refreshRetainedCount]);

  // ── Auto-select first request ───────────────────────────────────
  useEffect(() => {
    if (summaries && summaries.length > 0 && !getStore().selectedId) {
      getStore().setSelectedId(summaries[0]._id);
    }
  }, [summaries]);

  // ── Reset on endpoint change ────────────────────────────────────
  const currentEndpointId = currentEndpoint?._id;
  useEffect(() => {
    getStore().resetForEndpoint();
    clickHouseDetailMap.current.clear();
    prefetchedSlug.current = null;
  }, [currentEndpointId]);

  // ── Jump to new ─────────────────────────────────────────────────
  const handleJumpToNew = useCallback(() => {
    if (summaries && summaries.length > 0) {
      const s = getStore();
      s.setSelectedId(summaries[0]._id);
      s.setNewCount(0);
    }
  }, [summaries]);

  // ── Export helpers ──────────────────────────────────────────────
  const handleExportJson = useCallback(async () => {
    if (!currentEndpoint || !authToken) return;
    const { exportToJson, downloadFile } = await import("@/lib/export");
    const { methodFilter: mf, debouncedSearch: ds } = getStore();
    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: "200",
      order: "desc",
    };
    if (mf !== "ALL") params.method = mf;
    if (ds) params.q = ds;

    const { data: results, ok } = await fetchFromClickHouseImpl(authToken, params);
    if (!ok || results.length === 0) {
      alert("Export failed: could not fetch data. Please try again.");
      return;
    }
    downloadFile(exportToJson(results), "webhooks-export.json", "application/json");
    if (results.length >= 200) {
      alert("Exported first 200 requests. Use search filters to narrow the export.");
    }
  }, [currentEndpoint, authToken]);

  const handleExportCsv = useCallback(async () => {
    if (!currentEndpoint || !authToken) return;
    const { exportToCsv, downloadFile } = await import("@/lib/export");
    const { methodFilter: mf, debouncedSearch: ds } = getStore();
    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: "200",
      order: "desc",
    };
    if (mf !== "ALL") params.method = mf;
    if (ds) params.q = ds;

    const { data: results, ok } = await fetchFromClickHouseImpl(authToken, params);
    if (!ok || results.length === 0) {
      alert("Export failed: could not fetch data. Please try again.");
      return;
    }
    downloadFile(exportToCsv(results), "webhooks-export.csv", "text/csv");
    if (results.length >= 200) {
      alert("Exported first 200 requests. Use search filters to narrow the export.");
    }
  }, [currentEndpoint, authToken]);

  // ── Hover prefetch ──────────────────────────────────────────────
  const prefetchInflight = useRef(new Set<string>());
  const handlePrefetchDetail = useCallback(
    (id: string) => {
      if (clickHouseDetailMap.current.has(id) || prefetchInflight.current.has(id)) return;
      if (!currentEndpoint || !authToken) return;

      prefetchInflight.current.add(id);

      const isConvex = !id.includes(":");
      let receivedAt: number | undefined;
      if (isConvex && summaries) {
        const summary = summaries.find((s) => s._id === id);
        if (summary) receivedAt = summary.receivedAt;
      }

      if (isConvex && receivedAt == null) {
        prefetchInflight.current.delete(id);
        return;
      }

      const summaryMethod = summaries?.find((s) => s._id === id)?.method;

      fetchAndCacheDetail({
        id,
        slug: currentEndpoint.slug,
        receivedAt,
        summaryMethod,
        detailMap: clickHouseDetailMap.current,
        authToken,
      }).finally(() => {
        prefetchInflight.current.delete(id);
      });
    },
    [currentEndpoint, summaries, authToken]
  );

  // ── Computed values ─────────────────────────────────────────────
  const hasRequests = summaries && summaries.length > 0;
  const loadedCount = displayedItems.length;
  const initialCanLoadMore = (summaries?.length ?? 0) >= CLICKHOUSE_PAGE_SIZE;
  const showHasMore = computeShowHasMore({
    searchQuery: debouncedSearch,
    hasMoreFromPagination: hasMore,
    retainedTotalCount,
    loadedCount,
    hasLoadedOlderPage,
    initialCanLoadMore,
  });

  // Zustand store actions are stable references (never change identity),
  // so calling getStore().actionName here is safe and won't cause re-renders.
  return {
    // Data
    endpoints,
    currentEndpoint,
    summaries,
    displayedItems,
    displayRequest,
    hasRequests,

    // Selection
    selectedId,
    handleSelect: getStore().select,
    mobileDetail,
    setMobileDetail: getStore().setMobileDetail,

    // Controls
    liveMode,
    handleToggleLiveMode: getStore().toggleLiveMode,
    sortNewest,
    handleToggleSort: getStore().toggleSort,
    newCount,
    handleJumpToNew,
    methodFilter,
    setMethodFilter: getStore().setMethodFilter,
    searchInput,
    setSearchInput: getStore().setSearchInput,
    retainedTotalCount,

    // Pagination
    handleLoadMore,
    showHasMore,
    loadingMore,

    // Search
    searchLoading,
    searchError,

    // Export
    handleExportJson,
    handleExportCsv,

    // Hover prefetch
    handlePrefetchDetail,
  };
}
