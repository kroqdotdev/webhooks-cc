"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { useSearchParams } from "next/navigation";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { UrlBar } from "@/components/dashboard/url-bar";
import { RequestList } from "@/components/dashboard/request-list";
import { RequestDetail, RequestDetailEmpty } from "@/components/dashboard/request-detail";
import type { DisplayableRequest } from "@/components/dashboard/request-detail";
import { ErrorBoundary } from "@/components/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Check, Send, Download, ChevronDown } from "lucide-react";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import { exportToJson, exportToCsv, downloadFile } from "@/lib/export";
import type { ClickHouseRequest, ClickHouseSummary, AnyRequestSummary } from "@/types/request";

const CLICKHOUSE_PAGE_SIZE = 50;

export default function DashboardPage() {
  const endpoints = useQuery(api.endpoints.list);
  const searchParams = useSearchParams();
  const endpointSlug = searchParams.get("endpoint");

  const currentEndpoint = endpoints?.find((ep) => ep.slug === endpointSlug) ?? endpoints?.[0];

  // Lightweight summaries for the sidebar (no body/headers/ip)
  const summaries = useQuery(
    api.requests.listSummaries,
    currentEndpoint ? { endpointId: currentEndpoint._id, limit: 50 } : "skip"
  );

  // Selected item ID — can be a Convex _id (string) or a ClickHouse synthetic id
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [sortNewest, setSortNewest] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(false);
  const prevRequestCount = useRef(0);
  const [newCount, setNewCount] = useState(0);
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // ClickHouse state
  const [olderRequests, setOlderRequests] = useState<ClickHouseRequest[]>([]);
  const [searchResults, setSearchResults] = useState<ClickHouseRequest[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);

  // Map of ClickHouse request details by id for quick lookup
  const clickHouseDetailMap = useRef(new Map<string, ClickHouseRequest>());

  // Debounce search
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (searchInput === "") {
      setDebouncedSearch("");
      return;
    }
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(searchInput), 400);
    return () => clearTimeout(searchDebounceRef.current);
  }, [searchInput]);

  // Detail for selected request — prefer ClickHouse, Convex as fallback
  const isConvexId = selectedId != null && !selectedId.includes(":");
  const [selectedDetail, setSelectedDetail] = useState<ClickHouseRequest | null>(null);

  // Convex fallback for very new requests not yet flushed to ClickHouse
  const selectedRequest = useQuery(
    api.requests.get,
    isConvexId && !selectedDetail ? { id: selectedId as Id<"requests"> } : "skip"
  );

  // Request count from the endpoint doc (denormalized)
  const requestCount = currentEndpoint?.requestCount ?? 0;

  // Clear stale selectedId when request doesn't exist in either source
  useEffect(() => {
    if (selectedRequest === null && !selectedDetail && selectedId && isConvexId) {
      setSelectedId(null);
    }
  }, [selectedRequest, selectedDetail, selectedId, isConvexId]);

  // Build the displayable request for the detail panel
  const displayRequest = useMemo((): DisplayableRequest | undefined => {
    if (!selectedId) return undefined;
    // Prefer ClickHouse detail (snappier)
    if (selectedDetail) return selectedDetail;
    // Convex fallback for very new requests
    if (isConvexId) return selectedRequest ?? undefined;
    return undefined;
  }, [selectedId, selectedDetail, isConvexId, selectedRequest]);

  // Auth token for calling the search API route
  const authToken = useAuthToken();

  // ClickHouse search helper — calls Next.js API route (which proxies to receiver)
  // Returns { data, ok } to distinguish errors from empty results.
  const fetchFromClickHouse = useCallback(
    async (params: Record<string, string>): Promise<{ data: ClickHouseRequest[]; ok: boolean }> => {
      if (!authToken) return { data: [], ok: false };
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
        // Minimal shape validation: first element must have expected fields
        if (results.length > 0) {
          const first = results[0] as Record<string, unknown>;
          if (typeof first.id !== "string" || typeof first.method !== "string" || typeof first.receivedAt !== "number") {
            console.error("ClickHouse response shape mismatch:", first);
            return { data: [], ok: false };
          }
        }
        return { data: results as ClickHouseRequest[], ok: true };
      } catch (err) {
        console.error("ClickHouse search failed:", err);
        return { data: [], ok: false };
      }
    },
    [authToken]
  );

  // Store ClickHouse results in the detail map (capped at 500 entries)
  const storeClickHouseResults = useCallback((results: ClickHouseRequest[]) => {
    const map = clickHouseDetailMap.current;
    for (const r of results) {
      map.set(r.id, r);
    }
    // Evict oldest entries if map exceeds cap
    if (map.size > 500) {
      const excess = map.size - 500;
      const iter = map.keys();
      for (let i = 0; i < excess; i++) {
        const key = iter.next().value;
        if (key) map.delete(key);
      }
    }
  }, []);

  // Pre-fetch first page from ClickHouse and map Convex IDs to details
  const prefetchedSlug = useRef<string | null>(null);
  useEffect(() => {
    if (!currentEndpoint || !summaries?.length || !authToken) return;
    // Only pre-fetch once per endpoint
    if (prefetchedSlug.current === currentEndpoint.slug) return;

    const slugToFetch = currentEndpoint.slug;
    let cancelled = false;

    fetchFromClickHouse({
      slug: slugToFetch,
      limit: "50",
      order: "desc",
    }).then(({ data: results }) => {
      if (cancelled) return;
      // Mark as prefetched only after success
      prefetchedSlug.current = slugToFetch;
      storeClickHouseResults(results);
      // Map Convex _ids to ClickHouse details by matching receivedAt + method.
      // Track consumed matches to prevent the same ClickHouse result
      // being mapped to multiple Convex IDs.
      const consumed = new Set<string>();
      for (const summary of summaries) {
        const match = results.find(
          (r) => !consumed.has(r.id) && r.method === summary.method && Math.abs(r.receivedAt - summary.receivedAt) < 2
        );
        if (match) {
          consumed.add(match.id);
          clickHouseDetailMap.current.set(summary._id, match);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentEndpoint, summaries, authToken, fetchFromClickHouse, storeClickHouseResults]);

  // Fetch detail from ClickHouse when selection changes
  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      return;
    }

    // Check cache first (instant)
    const cached = clickHouseDetailMap.current.get(selectedId);
    if (cached) {
      setSelectedDetail(cached);
      return;
    }

    // Not in cache — clear stale detail and fetch from ClickHouse
    setSelectedDetail(null);

    if (!currentEndpoint) {
      return;
    }

    // For Convex IDs, find the receivedAt from summaries to query ClickHouse
    let receivedAt: number | undefined;
    if (isConvexId && summaries) {
      const summary = summaries.find((s) => s._id === selectedId);
      if (summary) receivedAt = summary.receivedAt;
    }

    if (isConvexId && receivedAt == null) {
      // Very new request, no timestamp yet — let Convex fallback handle it
      setSelectedDetail(null);
      return;
    }

    let cancelled = false;
    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: "10",
      order: "desc",
    };
    if (receivedAt != null) {
      params.from = String(receivedAt);
      params.to = String(receivedAt);
    }

    fetchFromClickHouse(params).then(({ data: results }) => {
      if (cancelled) return;
      storeClickHouseResults(results);
      if (receivedAt != null && results.length > 0) {
        // Match by closest timestamp + method from summary
        const summaryMethod = summaries?.find((s) => s._id === selectedId)?.method;
        const candidates = summaryMethod
          ? results.filter((r) => r.method === summaryMethod)
          : results;
        const pool = candidates.length > 0 ? candidates : results;
        const match = pool.reduce((best, r) =>
          Math.abs(r.receivedAt - receivedAt!) < Math.abs(best.receivedAt - receivedAt!) ? r : best
        );
        clickHouseDetailMap.current.set(selectedId, match);
        setSelectedDetail(match);
      } else if (results.length > 0) {
        // ClickHouse ID — should already be in results
        const match = results.find((r) => r.id === selectedId);
        if (match) setSelectedDetail(match);
      } else {
        setSelectedDetail(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    selectedId,
    isConvexId,
    currentEndpoint,
    summaries,
    fetchFromClickHouse,
    storeClickHouseResults,
  ]);

  // Clear paginated results when filter changes (avoid stale items from previous filter)
  const prevMethodFilter = useRef(methodFilter);
  useEffect(() => {
    if (prevMethodFilter.current !== methodFilter) {
      prevMethodFilter.current = methodFilter;
      setOlderRequests([]);
      setHasMore(false);
    }
  }, [methodFilter]);

  // Handle Load More
  const handleLoadMore = useCallback(async () => {
    if (!currentEndpoint || loadingMore) return;
    setLoadingMore(true);

    // Get the oldest timestamp from current items for cursor-based pagination
    const currentOldest = olderRequests.length > 0 ? olderRequests[olderRequests.length - 1] : null;
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
    if (methodFilter !== "ALL") params.method = methodFilter;
    if (toTimestamp != null) params.to = String(Math.floor(toTimestamp) - 1);

    try {
      const { data: results } = await fetchFromClickHouse(params);
      storeClickHouseResults(results);
      setOlderRequests((prev) => [...prev, ...results]);
      setHasMore(results.length >= CLICKHOUSE_PAGE_SIZE);
    } catch (err) {
      console.error("Load more failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [
    currentEndpoint,
    loadingMore,
    olderRequests,
    summaries,
    methodFilter,
    fetchFromClickHouse,
    storeClickHouseResults,
  ]);

  // Handle search via ClickHouse
  useEffect(() => {
    if (!debouncedSearch || !currentEndpoint) {
      setSearchResults([]);
      setSearchError(false);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    setSearchError(false);

    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      q: debouncedSearch,
      limit: String(CLICKHOUSE_PAGE_SIZE),
      order: "desc",
    };
    if (methodFilter !== "ALL") params.method = methodFilter;

    fetchFromClickHouse(params)
      .then(({ data: results, ok }) => {
        if (cancelled) return;
        if (!ok) {
          setSearchError(true);
          setSearchResults([]);
        } else {
          storeClickHouseResults(results);
          setSearchResults(results);
        }
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, currentEndpoint, methodFilter, fetchFromClickHouse, storeClickHouseResults]);

  // Compose the list to display
  const displayedItems = useMemo((): AnyRequestSummary[] => {
    // Search mode: show ClickHouse search results as summaries
    if (debouncedSearch) {
      return searchResults.map(
        (r): ClickHouseSummary => ({
          id: r.id,
          method: r.method,
          receivedAt: r.receivedAt,
        })
      );
    }

    // Normal mode: Convex summaries + older ClickHouse items
    const convexSummaries: AnyRequestSummary[] = summaries
      ? methodFilter === "ALL"
        ? summaries
        : summaries.filter((r) => r.method === methodFilter)
      : [];

    // Deduplicate: exclude ClickHouse items whose receivedAt overlaps with Convex window.
    // Use unfiltered summaries for the boundary so a method filter that excludes all
    // Convex items doesn't collapse oldestConvex to -Infinity and drop everything.
    const oldestConvex =
      summaries && summaries.length > 0
        ? summaries[summaries.length - 1].receivedAt
        : -Infinity;
    const olderSummaries: ClickHouseSummary[] = olderRequests
      .filter((r) => r.receivedAt < oldestConvex)
      .map((r) => ({
        id: r.id,
        method: r.method,
        receivedAt: r.receivedAt,
      }));

    return [...convexSummaries, ...olderSummaries];
  }, [summaries, olderRequests, searchResults, debouncedSearch, methodFilter]);

  // Track incoming requests for live mode
  useEffect(() => {
    if (!summaries) return;

    const currentCount = summaries.length;
    const diff = currentCount - prevRequestCount.current;

    if (prevRequestCount.current > 0 && diff > 0) {
      if (liveMode) {
        setSelectedId(summaries[0]._id);
      } else {
        setNewCount((prev) => prev + diff);
      }
    }

    prevRequestCount.current = currentCount;
  }, [summaries, liveMode]);

  // Auto-select first request when requests load and nothing is selected
  useEffect(() => {
    if (summaries && summaries.length > 0 && !selectedId) {
      setSelectedId(summaries[0]._id);
    }
  }, [summaries, selectedId]);

  // Reset state when endpoint changes
  const currentEndpointId = currentEndpoint?._id;
  useEffect(() => {
    setSelectedId(null);
    setSelectedDetail(null);
    setNewCount(0);
    prevRequestCount.current = 0;
    setMethodFilter("ALL");
    setSearchInput("");
    setDebouncedSearch("");
    setOlderRequests([]);
    setSearchResults([]);
    setHasMore(false);
    setLoadingMore(false);
    setSearchLoading(false);
    setSearchError(false);
    clickHouseDetailMap.current.clear();
    prefetchedSlug.current = null;
  }, [currentEndpointId]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileDetail(true);
  }, []);

  const handleToggleLiveMode = useCallback(() => setLiveMode((prev) => !prev), []);
  const handleToggleSort = useCallback(() => setSortNewest((prev) => !prev), []);

  const handleJumpToNew = useCallback(() => {
    if (summaries && summaries.length > 0) {
      setSelectedId(summaries[0]._id);
      setNewCount(0);
    }
  }, [summaries]);

  // Export helpers — fetch from ClickHouse for full data
  const handleExportJson = useCallback(async () => {
    if (!currentEndpoint) return;
    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: "200",
      order: "desc",
    };
    if (methodFilter !== "ALL") params.method = methodFilter;
    if (debouncedSearch) params.q = debouncedSearch;

    const { data: results, ok } = await fetchFromClickHouse(params);
    if (!ok || results.length === 0) {
      alert("Export failed: could not fetch data. Please try again.");
      return;
    }
    downloadFile(exportToJson(results), "webhooks-export.json", "application/json");
    if (results.length >= 200) {
      alert(`Exported 200 of ${requestCount} requests. Use search filters to narrow the export.`);
    }
  }, [currentEndpoint, methodFilter, debouncedSearch, fetchFromClickHouse, requestCount]);

  const handleExportCsv = useCallback(async () => {
    if (!currentEndpoint) return;
    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: "200",
      order: "desc",
    };
    if (methodFilter !== "ALL") params.method = methodFilter;
    if (debouncedSearch) params.q = debouncedSearch;

    const { data: results, ok } = await fetchFromClickHouse(params);
    if (!ok || results.length === 0) {
      alert("Export failed: could not fetch data. Please try again.");
      return;
    }
    downloadFile(exportToCsv(results), "webhooks-export.csv", "text/csv");
    if (results.length >= 200) {
      alert(`Exported 200 of ${requestCount} requests. Use search filters to narrow the export.`);
    }
  }, [currentEndpoint, methodFilter, debouncedSearch, fetchFromClickHouse, requestCount]);

  if (endpoints === undefined) {
    return <DashboardSkeleton />;
  }

  if (endpoints.length === 0) {
    return <EmptyEndpoints />;
  }

  if (!currentEndpoint) return null;

  const hasRequests = summaries && summaries.length > 0;
  // Show "hasMore" only in non-search mode and when the total count exceeds loaded items
  const showHasMore =
    !debouncedSearch && (hasMore || requestCount > (summaries?.length ?? 0) + olderRequests.length);

  return (
    <ErrorBoundary resetKey={currentEndpoint._id}>
      {/* URL Bar */}
      <UrlBar
        endpointId={currentEndpoint._id}
        endpointName={currentEndpoint.name || currentEndpoint.slug}
        slug={currentEndpoint.slug}
        mockResponse={currentEndpoint.mockResponse}
        extra={
          hasRequests ? (
            <ExportDropdown onExportJson={handleExportJson} onExportCsv={handleExportCsv} />
          ) : undefined
        }
      />

      {/* Split pane or empty state */}
      {hasRequests ? (
        <>
          {/* Desktop: side-by-side */}
          <div className="hidden md:flex flex-1 overflow-hidden">
            <div className="w-80 shrink-0 border-r-2 border-foreground overflow-hidden">
              <RequestList
                requests={displayedItems}
                selectedId={selectedId}
                onSelect={handleSelect}
                liveMode={liveMode}
                onToggleLiveMode={handleToggleLiveMode}
                sortNewest={sortNewest}
                onToggleSort={handleToggleSort}
                newCount={newCount}
                onJumpToNew={handleJumpToNew}
                totalCount={requestCount}
                methodFilter={methodFilter}
                onMethodFilterChange={setMethodFilter}
                searchQuery={searchInput}
                onSearchQueryChange={setSearchInput}
                onLoadMore={handleLoadMore}
                hasMore={showHasMore}
                loadingMore={loadingMore}
                searchLoading={searchLoading}
                searchError={searchError}
              />
            </div>
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary resetKey={selectedId ?? undefined}>
                {displayRequest ? (
                  <RequestDetail request={displayRequest} />
                ) : (
                  <RequestDetailEmpty />
                )}
              </ErrorBoundary>
            </div>
          </div>

          {/* Mobile: list or detail */}
          <div className="md:hidden flex-1 overflow-hidden flex flex-col">
            {mobileDetail && displayRequest ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <button
                  onClick={() => setMobileDetail(false)}
                  className="border-b-2 border-foreground px-4 py-2 text-sm font-bold uppercase tracking-wide hover:bg-muted cursor-pointer transition-colors shrink-0"
                >
                  &larr; Back to list
                </button>
                <div className="flex-1 overflow-hidden">
                  <ErrorBoundary resetKey={selectedId ?? undefined}>
                    <RequestDetail request={displayRequest} />
                  </ErrorBoundary>
                </div>
              </div>
            ) : (
              <RequestList
                requests={displayedItems}
                selectedId={selectedId}
                onSelect={handleSelect}
                liveMode={liveMode}
                onToggleLiveMode={handleToggleLiveMode}
                sortNewest={sortNewest}
                onToggleSort={handleToggleSort}
                newCount={newCount}
                onJumpToNew={handleJumpToNew}
                totalCount={requestCount}
                methodFilter={methodFilter}
                onMethodFilterChange={setMethodFilter}
                searchQuery={searchInput}
                onSearchQueryChange={setSearchInput}
                onLoadMore={handleLoadMore}
                hasMore={showHasMore}
                loadingMore={loadingMore}
                searchLoading={searchLoading}
                searchError={searchError}
              />
            )}
          </div>
        </>
      ) : (
        <WaitingForRequests slug={currentEndpoint.slug} />
      )}
    </ErrorBoundary>
  );
}

function ExportDropdown({
  onExportJson,
  onExportCsv,
}: {
  onExportJson: () => void;
  onExportCsv: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="neo-btn-outline !py-1.5 !px-3 text-xs flex items-center gap-1.5"
      >
        <Download className="h-3.5 w-3.5" />
        Export
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 border-2 border-foreground bg-background shadow-neo z-50 min-w-[140px]">
          <button
            onClick={() => {
              onExportJson();
              setOpen(false);
            }}
            className="w-full px-3 py-2 text-left text-xs font-bold uppercase tracking-wide hover:bg-muted cursor-pointer transition-colors border-b-2 border-foreground"
          >
            Export JSON
          </button>
          <button
            onClick={() => {
              onExportCsv();
              setOpen(false);
            }}
            className="w-full px-3 py-2 text-left text-xs font-bold uppercase tracking-wide hover:bg-muted cursor-pointer transition-colors"
          >
            Export CSV
          </button>
        </div>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex-1 flex flex-col">
      {/* URL bar skeleton */}
      <div className="border-b-2 border-foreground bg-card px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 flex-1 max-w-md" />
        </div>
      </div>
      {/* Content skeleton */}
      <div className="flex-1 flex">
        {/* List skeleton */}
        <div className="w-80 shrink-0 border-r-2 border-foreground hidden md:block">
          <div className="border-b-2 border-foreground px-3 py-2">
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="p-3 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-6 w-14" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </div>
        </div>
        {/* Detail skeleton */}
        <div className="flex-1 p-4 space-y-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-48" />
          </div>
          <div className="flex gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-20" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}

function WaitingForRequests({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sentTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
    };
  }, []);

  const url = `${WEBHOOK_BASE_URL}/w/${slug}`;
  const curlCmd = `curl -X POST ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"test": true}'`;

  const handleCopy = async () => {
    const success = await copyToClipboard(curlCmd);
    if (success) {
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSendTest = async () => {
    setSending(true);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true, sentAt: new Date().toISOString() }),
      });
      setSent(true);
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
      sentTimeoutRef.current = setTimeout(() => setSent(false), 3000);
    } catch {
      // Ignore - might be CORS, request still reaches the receiver
      setSent(true);
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
      sentTimeoutRef.current = setTimeout(() => setSent(false), 3000);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-lg w-full text-center space-y-6">
        <div className="flex items-center justify-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-primary" />
          </span>
          <p className="font-bold uppercase tracking-wide">Waiting for first request...</p>
        </div>

        <div className="text-left">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Send a test webhook
            </span>
            <button
              onClick={handleCopy}
              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1 transition-colors"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3" /> Copied!
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" /> Copy
                </>
              )}
            </button>
          </div>
          <pre className="neo-code text-sm whitespace-pre-wrap break-all text-left">{curlCmd}</pre>
        </div>

        <button
          onClick={handleSendTest}
          disabled={sending}
          className="neo-btn-primary w-full flex items-center justify-center gap-2"
        >
          <Send className="h-4 w-4" />
          {sending ? "Sending..." : sent ? "Sent!" : "Send test request"}
        </button>
      </div>
    </div>
  );
}

function EmptyEndpoints() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 border-2 border-foreground bg-muted flex items-center justify-center mx-auto mb-2">
          <Send className="h-8 w-8 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-bold uppercase tracking-wide">No endpoints yet</h2>
        <p className="text-muted-foreground max-w-sm">
          Create your first endpoint to start capturing webhooks. Click{" "}
          <span className="font-bold text-foreground">&quot;New Endpoint&quot;</span> above.
        </p>
      </div>
    </div>
  );
}
