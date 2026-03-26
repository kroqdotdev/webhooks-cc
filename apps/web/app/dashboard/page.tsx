"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { UrlBar } from "@/components/dashboard/url-bar";
import { RequestList } from "@/components/dashboard/request-list";
import {
  RequestDetail,
  RequestDetailEmpty,
  TABS,
  type Tab,
} from "@/components/dashboard/request-detail";
import { GettingStarted } from "@/components/dashboard/getting-started";
import { KeyboardShortcutsDialog } from "@/components/dashboard/keyboard-shortcuts-dialog";

import { ErrorBoundary } from "@/components/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Check, Send, Download, ChevronDown } from "lucide-react";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import { exportToJson, exportToCsv, downloadFile } from "@/lib/export";
import { trackRequestExported } from "@/lib/analytics";
import { subscribeToEndpointRequestInserts } from "@/lib/supabase/realtime";
import {
  fetchDashboardEndpoints,
  fetchDashboardRequests,
  fetchDashboardSearch,
  fetchDashboardSearchCount,
  subscribeDashboardEndpointsChanged,
  createDashboardEndpoint,
  claimGuestEndpointForUser,
  type DashboardEndpoint,
} from "@/lib/dashboard-api";
import { buildRetainedCountParams, computeShowHasMore } from "@/lib/dashboard-count";
import type {
  ClickHouseRequest,
  ClickHouseSummary,
  AnyRequestSummary,
  Request,
} from "@/types/request";

const CLICKHOUSE_PAGE_SIZE = 50;
const PANE_MIN = 240;
const PANE_DEFAULT = 320;

export default function DashboardPage() {
  const { session, isLoading: authLoading } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [endpoints, setEndpoints] = useState<DashboardEndpoint[] | undefined>(undefined);
  const [recentRequests, setRecentRequests] = useState<Request[]>([]);
  const searchParams = useSearchParams();
  const endpointSlug = searchParams.get("endpoint");

  const currentEndpoint = endpoints?.find((ep) => ep.slug === endpointSlug) ?? endpoints?.[0];
  const currentEndpointId = currentEndpoint?.id;
  const currentSlug = currentEndpoint?.slug;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedClickHouseDetail, setSelectedClickHouseDetail] =
    useState<ClickHouseRequest | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [sortNewest, setSortNewest] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(false);
  const prevTopSummaryId = useRef<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Resizable split pane
  const [paneWidth, setPaneWidth] = useState(() => {
    if (typeof window === "undefined") return PANE_DEFAULT;
    try {
      const stored = localStorage.getItem("dashboard_pane_width");
      if (stored === "collapsed") return 0;
      const val = stored ? parseInt(stored, 10) : PANE_DEFAULT;
      if (!Number.isFinite(val)) return PANE_DEFAULT;
      const maxWidth = Math.floor(window.innerWidth * 0.5);
      return maxWidth >= PANE_MIN ? Math.max(PANE_MIN, Math.min(maxWidth, val)) : PANE_DEFAULT;
    } catch {
      return PANE_DEFAULT;
    }
  });
  const isDragging = useRef(false);
  const paneCollapsed = paneWidth === 0;
  const paneWidthRef = useRef(paneWidth);
  paneWidthRef.current = paneWidth;

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (paneWidthRef.current === 0) return;
    e.preventDefault();
    isDragging.current = true;
    const startX = e.clientX;
    const startWidth = paneWidthRef.current;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const maxWidth = Math.floor(window.innerWidth * 0.5);
      const newWidth = Math.max(PANE_MIN, Math.min(maxWidth, startWidth + (ev.clientX - startX)));
      setPaneWidth(newWidth);
    };

    const onMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Persist after drag ends
      setPaneWidth((w) => {
        try {
          localStorage.setItem("dashboard_pane_width", String(w));
        } catch {
          /* noop */
        }
        return w;
      });
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const toggleCollapse = useCallback(() => {
    setPaneWidth((prev) => {
      const next = prev === 0 ? PANE_DEFAULT : 0;
      try {
        localStorage.setItem("dashboard_pane_width", next === 0 ? "collapsed" : String(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  // Keyboard shortcuts dialog
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const desktopSearchInputRef = useRef<HTMLInputElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);

  // Tab state from URL — read searchParams for deriving current tab,
  // but write via window.location.search to avoid subscribing to the object (rerender-defer-reads).
  const router = useRouter();
  const pathname = usePathname();
  const tabParam = searchParams.get("tab") as Tab | null;
  const activeTab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "body";
  const setActiveTab = useCallback(
    (tab: Tab) => {
      const params = new URLSearchParams(window.location.search);
      if (tab === "body") {
        params.delete("tab");
      } else {
        params.set("tab", tab);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname]
  );

  // Retained request history state
  const [olderRequests, setOlderRequests] = useState<ClickHouseRequest[]>([]);
  const [searchResults, setSearchResults] = useState<ClickHouseRequest[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [hasLoadedOlderPage, setHasLoadedOlderPage] = useState(false);
  const [retainedTotalCount, setRetainedTotalCount] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const retainedCountRequestSeq = useRef(0);
  const recentRequestsRequestSeq = useRef(0);
  const searchResultsRequestSeq = useRef(0);
  const realtimeRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clickHouseDetailMap = useRef(new Map<string, ClickHouseRequest>());

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (searchInput === "") {
      setDebouncedSearch("");
      return;
    }
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(searchInput), 400);
    return () => clearTimeout(searchDebounceRef.current);
  }, [searchInput]);

  const guestClaimAttempted = useRef(false);

  const loadEndpoints = useCallback(async () => {
    if (!accessToken) return;

    // On first load, try to claim a guest endpoint from /go
    if (!guestClaimAttempted.current) {
      guestClaimAttempted.current = true;
      try {
        const stored = localStorage.getItem("demo_endpoint");
        if (stored) {
          const parsed = JSON.parse(stored) as { slug?: string };
          if (parsed.slug) {
            await claimGuestEndpointForUser(accessToken, parsed.slug);
          }
          localStorage.removeItem("demo_endpoint");
        }
      } catch {
        // Claim is best-effort — proceed with normal load
      }
    }

    try {
      const nextEndpoints = await fetchDashboardEndpoints(accessToken);
      setEndpoints(nextEndpoints);
    } catch (error) {
      console.error("Failed to load dashboard endpoints:", error);
      setEndpoints([]);
    }
  }, [accessToken]);

  const refreshRecentRequests = useCallback(async () => {
    if (!accessToken || !currentSlug) {
      recentRequestsRequestSeq.current++;
      setRecentRequests([]);
      return;
    }

    const requestSeq = ++recentRequestsRequestSeq.current;

    try {
      const nextRequests = await fetchDashboardRequests(accessToken, currentSlug, 50);
      if (requestSeq === recentRequestsRequestSeq.current) {
        setRecentRequests(nextRequests);
      }
    } catch (error) {
      console.error("Failed to load dashboard requests:", error);
      if (requestSeq === recentRequestsRequestSeq.current) {
        setRecentRequests([]);
      }
    }
  }, [accessToken, currentSlug]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadEndpoints();
    const unsubscribe = subscribeDashboardEndpointsChanged(() => {
      void loadEndpoints();
    });

    return unsubscribe;
  }, [accessToken, loadEndpoints]);

  useEffect(() => {
    void refreshRecentRequests();
  }, [refreshRecentRequests]);

  const selectedRecentRequest = useMemo(
    () => recentRequests.find((request) => request._id === selectedId),
    [recentRequests, selectedId]
  );

  const displayRequest = selectedRecentRequest ?? selectedClickHouseDetail ?? undefined;

  const fetchFromClickHouse = useCallback(
    async (params: Record<string, string>): Promise<{ data: ClickHouseRequest[]; ok: boolean }> => {
      if (!accessToken) return { data: [], ok: false };
      try {
        const results = await fetchDashboardSearch(accessToken, params);
        return { data: results, ok: true };
      } catch (err) {
        console.error("ClickHouse search failed:", err);
        return { data: [], ok: false };
      }
    },
    [accessToken]
  );

  const fetchCountFromClickHouse = useCallback(
    async (params: Record<string, string>): Promise<{ count: number | null; ok: boolean }> => {
      if (!accessToken) return { count: null, ok: false };
      try {
        const count = await fetchDashboardSearchCount(accessToken, params);
        return { count, ok: true };
      } catch (err) {
        console.error("ClickHouse count failed:", err);
        return { count: null, ok: false };
      }
    },
    [accessToken]
  );

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

  useEffect(() => {
    if (!selectedId) {
      setSelectedClickHouseDetail(null);
      return;
    }
    if (selectedRecentRequest) {
      setSelectedClickHouseDetail(null);
      return;
    }
    setSelectedClickHouseDetail(clickHouseDetailMap.current.get(selectedId) ?? null);
  }, [selectedId, selectedRecentRequest]);

  const prevMethodFilter = useRef(methodFilter);
  useEffect(() => {
    if (prevMethodFilter.current !== methodFilter) {
      prevMethodFilter.current = methodFilter;
      setOlderRequests([]);
      setHasMore(false);
      setHasLoadedOlderPage(false);
    }
  }, [methodFilter]);

  const handleLoadMore = useCallback(async () => {
    if (!currentEndpoint || loadingMore) return;
    setLoadingMore(true);

    const currentOldest = olderRequests.length > 0 ? olderRequests[olderRequests.length - 1] : null;
    const oldestRecentRequest =
      recentRequests.length > 0 ? recentRequests[recentRequests.length - 1] : null;

    const toTimestamp = currentOldest?.receivedAt ?? oldestRecentRequest?.receivedAt;

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
      setHasLoadedOlderPage(true);
    } catch (err) {
      console.error("Load more failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [
    currentEndpoint,
    loadingMore,
    olderRequests,
    recentRequests,
    methodFilter,
    fetchFromClickHouse,
    storeClickHouseResults,
  ]);

  const refreshSearchResults = useCallback(
    async ({ showLoading }: { showLoading: boolean }) => {
      if (!debouncedSearch || !currentEndpoint) {
        searchResultsRequestSeq.current++;
        setSearchResults([]);
        setSearchError(false);
        setSearchLoading(false);
        return;
      }

      const requestSeq = ++searchResultsRequestSeq.current;
      if (showLoading) {
        setSearchLoading(true);
      }
      setSearchError(false);

      const params: Record<string, string> = {
        slug: currentEndpoint.slug,
        q: debouncedSearch,
        limit: String(CLICKHOUSE_PAGE_SIZE),
        order: "desc",
      };
      if (methodFilter !== "ALL") params.method = methodFilter;

      const { data: results, ok } = await fetchFromClickHouse(params);
      if (requestSeq !== searchResultsRequestSeq.current) return;

      if (!ok) {
        setSearchError(true);
        setSearchResults([]);
      } else {
        storeClickHouseResults(results);
        setSearchResults(results);
      }

      setSearchLoading(false);
    },
    [currentEndpoint, debouncedSearch, methodFilter, fetchFromClickHouse, storeClickHouseResults]
  );

  useEffect(() => {
    if (!debouncedSearch || !currentEndpoint) {
      setSearchResults([]);
      setSearchError(false);
      setSearchLoading(false);
      return;
    }

    void refreshSearchResults({ showLoading: true });
  }, [debouncedSearch, currentEndpoint, refreshSearchResults]);

  const refreshRetainedCount = useCallback(async () => {
    if (!currentSlug) return;
    const requestSeq = ++retainedCountRequestSeq.current;
    const params = buildRetainedCountParams(currentSlug, methodFilter, debouncedSearch);

    const { count, ok } = await fetchCountFromClickHouse(params);
    if (requestSeq !== retainedCountRequestSeq.current) return;
    if (ok && count != null) {
      setRetainedTotalCount(count);
    }
  }, [currentSlug, methodFilter, debouncedSearch, fetchCountFromClickHouse]);

  useEffect(() => {
    if (!currentSlug || !accessToken) {
      retainedCountRequestSeq.current++;
      setRetainedTotalCount(null);
      return;
    }
    void refreshRetainedCount();
  }, [currentSlug, accessToken, methodFilter, debouncedSearch, refreshRetainedCount]);

  useEffect(() => {
    if (!currentSlug || !accessToken) return;

    const onFocus = () => {
      void refreshRecentRequests();
      if (debouncedSearch) {
        void refreshSearchResults({ showLoading: false });
      }
      void refreshRetainedCount();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        onFocus();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    accessToken,
    currentSlug,
    debouncedSearch,
    refreshRecentRequests,
    refreshRetainedCount,
    refreshSearchResults,
  ]);

  useEffect(() => {
    if (!currentEndpointId) {
      return;
    }

    const queueRefresh = () => {
      if (realtimeRefreshTimeoutRef.current) {
        clearTimeout(realtimeRefreshTimeoutRef.current);
      }

      realtimeRefreshTimeoutRef.current = setTimeout(() => {
        void refreshRecentRequests();
        if (debouncedSearch) {
          void refreshSearchResults({ showLoading: false });
        }

        void refreshRetainedCount();
      }, 150);
    };

    const unsubscribe = subscribeToEndpointRequestInserts(currentEndpointId, queueRefresh);
    return () => {
      if (realtimeRefreshTimeoutRef.current) {
        clearTimeout(realtimeRefreshTimeoutRef.current);
        realtimeRefreshTimeoutRef.current = undefined;
      }
      unsubscribe();
    };
  }, [
    currentEndpointId,
    debouncedSearch,
    refreshRecentRequests,
    refreshRetainedCount,
    refreshSearchResults,
  ]);

  const displayedItems = useMemo((): AnyRequestSummary[] => {
    if (debouncedSearch) {
      return searchResults.map(
        (r): ClickHouseSummary => ({
          id: r.id,
          method: r.method,
          path: r.path,
          contentType: r.contentType,
          size: r.size,
          receivedAt: r.receivedAt,
        })
      );
    }

    const recentSummaries: AnyRequestSummary[] = recentRequests
      .filter((request) => methodFilter === "ALL" || request.method === methodFilter)
      .map((request) => ({
        _id: request._id,
        _creationTime: request._creationTime,
        method: request.method,
        path: request.path,
        contentType: request.contentType,
        size: request.size,
        receivedAt: request.receivedAt,
      }));

    const oldestRecent =
      recentRequests.length > 0 ? recentRequests[recentRequests.length - 1].receivedAt : -Infinity;
    const olderSummaries: ClickHouseSummary[] = olderRequests
      .filter((r) => r.receivedAt < oldestRecent)
      .map((r) => ({
        id: r.id,
        method: r.method,
        path: r.path,
        contentType: r.contentType,
        size: r.size,
        receivedAt: r.receivedAt,
      }));

    return [...recentSummaries, ...olderSummaries];
  }, [recentRequests, olderRequests, searchResults, debouncedSearch, methodFilter]);

  useEffect(() => {
    if (recentRequests.length === 0) {
      prevTopSummaryId.current = null;
      return;
    }

    const topId = recentRequests[0]._id;
    const previousTopId = prevTopSummaryId.current;

    if (previousTopId && topId !== previousTopId) {
      const previousIdx = recentRequests.findIndex((request) => request._id === previousTopId);
      const arrived = previousIdx >= 0 ? previousIdx : 1;

      if (arrived > 0) {
        if (liveMode) {
          setSelectedId(topId);
        } else {
          setNewCount((prev) => prev + arrived);
        }

        if (previousIdx === -1) {
          void refreshRetainedCount();
        }
      }
    }

    prevTopSummaryId.current = topId;
  }, [recentRequests, liveMode, refreshRetainedCount]);

  useEffect(() => {
    if (recentRequests.length > 0 && !selectedId) {
      setSelectedId(recentRequests[0]._id);
    }
  }, [recentRequests, selectedId]);

  useEffect(() => {
    setSelectedId(null);
    setSelectedClickHouseDetail(null);
    setNewCount(0);
    prevTopSummaryId.current = null;
    setMethodFilter("ALL");
    setSearchInput("");
    setDebouncedSearch("");
    setOlderRequests([]);
    setSearchResults([]);
    setHasMore(false);
    setHasLoadedOlderPage(false);
    setRetainedTotalCount(null);
    setLoadingMore(false);
    setSearchLoading(false);
    setSearchError(false);
    clickHouseDetailMap.current.clear();
  }, [currentEndpointId]);

  useEffect(() => {
    return () => {
      if (realtimeRefreshTimeoutRef.current) {
        clearTimeout(realtimeRefreshTimeoutRef.current);
      }
    };
  }, []);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileDetail(true);
  }, []);

  const handleToggleLiveMode = useCallback(() => setLiveMode((prev) => !prev), []);
  const handleToggleSort = useCallback(() => setSortNewest((prev) => !prev), []);

  const handleJumpToNew = useCallback(() => {
    if (recentRequests.length > 0) {
      setSelectedId(recentRequests[0]._id);
      setNewCount(0);
    }
  }, [recentRequests]);

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
    trackRequestExported("json", results.length);
    if (results.length >= 200) {
      alert("Exported first 200 requests. Use search filters to narrow the export.");
    }
  }, [currentEndpoint, methodFilter, debouncedSearch, fetchFromClickHouse]);

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
    trackRequestExported("csv", results.length);
    if (results.length >= 200) {
      alert("Exported first 200 requests. Use search filters to narrow the export.");
    }
  }, [currentEndpoint, methodFilter, debouncedSearch, fetchFromClickHouse]);

  // Keyboard shortcuts — use refs for frequently-changing values so the
  // listener doesn't re-register on every state change (rerender-dependencies).
  const displayedItemsRef = useRef(displayedItems);
  displayedItemsRef.current = displayedItems;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const displayRequestRef = useRef(displayRequest);
  displayRequestRef.current = displayRequest;

  // Ref for cURL button (avoids DOM scraping in keyboard handler)
  const curlBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // Esc always works
      if (e.key === "Escape") {
        setShortcutsOpen(false);
        if (isInput) {
          (e.target as HTMLElement).blur();
        }
        return;
      }

      // Don't intercept when typing in inputs
      if (isInput) return;
      // Don't intercept when modifiers are held (allow browser shortcuts)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case "?":
          e.preventDefault();
          setShortcutsOpen(true);
          break;
        case "/":
          e.preventDefault();
          (window.matchMedia("(min-width: 768px)").matches
            ? desktopSearchInputRef.current
            : mobileSearchInputRef.current
          )?.focus();
          break;
        case "j":
        case "k": {
          e.preventDefault();
          const items = displayedItemsRef.current;
          if (items.length === 0) break;
          const ids = items.map((item) => ("_id" in item ? item._id : item.id));
          const currentIndex = selectedIdRef.current ? ids.indexOf(selectedIdRef.current) : -1;
          const nextIndex =
            e.key === "j"
              ? Math.min(currentIndex + 1, ids.length - 1)
              : Math.max(currentIndex - 1, 0);
          handleSelect(ids[nextIndex]);
          break;
        }
        case "1":
        case "2":
        case "3":
        case "4": {
          e.preventDefault();
          const tabIndex = parseInt(e.key) - 1;
          setActiveTab(TABS[tabIndex]);
          break;
        }
        case "c":
          if (displayRequestRef.current) {
            e.preventDefault();
            curlBtnRef.current?.click();
          }
          break;
        case "r":
          if (displayRequestRef.current) {
            e.preventDefault();
            document.querySelector<HTMLButtonElement>('[data-shortcut="replay"]')?.click();
          }
          break;
        case "n":
          e.preventDefault();
          document.querySelector<HTMLButtonElement>('[data-shortcut="new-endpoint"]')?.click();
          break;
        case "l":
          e.preventDefault();
          handleToggleLiveMode();
          break;
        case "[":
          e.preventDefault();
          toggleCollapse();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSelect, handleToggleLiveMode, setActiveTab, toggleCollapse]);

  if (authLoading || endpoints === undefined) {
    return <DashboardSkeleton />;
  }

  if (endpoints.length === 0) {
    return <AutoCreateEndpoint accessToken={accessToken} onCreated={loadEndpoints} />;
  }

  if (!currentEndpoint) return null;

  const hasRequests = recentRequests.length > 0;
  const loadedCount = displayedItems.length;
  const initialCanLoadMore = recentRequests.length >= CLICKHOUSE_PAGE_SIZE;
  const showHasMore = computeShowHasMore({
    searchQuery: debouncedSearch,
    hasMoreFromPagination: hasMore,
    retainedTotalCount,
    loadedCount,
    hasLoadedOlderPage,
    initialCanLoadMore,
  });

  return (
    <ErrorBoundary resetKey={currentEndpoint.id}>
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {/* URL Bar */}
      <UrlBar
        endpointId={currentEndpoint.id}
        endpointName={currentEndpoint.name || currentEndpoint.slug}
        slug={currentEndpoint.slug}
        mockResponse={currentEndpoint.mockResponse}
        extra={
          hasRequests ? (
            <ExportDropdown onExportJson={handleExportJson} onExportCsv={handleExportCsv} />
          ) : undefined
        }
      />
      <GettingStarted hasReceivedWebhook={hasRequests} />

      {/* Split pane or empty state */}
      {hasRequests ? (
        <>
          {/* Desktop: side-by-side with resizable pane */}
          <div className="hidden md:flex flex-1 overflow-hidden">
            {!paneCollapsed && (
              <div className="shrink-0 overflow-hidden" style={{ width: paneWidth }}>
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
                  totalCount={retainedTotalCount ?? undefined}
                  methodFilter={methodFilter}
                  onMethodFilterChange={setMethodFilter}
                  searchQuery={searchInput}
                  onSearchQueryChange={setSearchInput}
                  onLoadMore={handleLoadMore}
                  hasMore={showHasMore}
                  loadingMore={loadingMore}
                  searchLoading={searchLoading}
                  searchError={searchError}
                  searchInputRef={desktopSearchInputRef}
                />
              </div>
            )}
            {/* Drag handle / divider */}
            <div
              className="shrink-0 border-r-2 border-foreground relative group cursor-col-resize select-none"
              onMouseDown={handleDragStart}
              onDoubleClick={toggleCollapse}
              title={paneCollapsed ? "Expand sidebar" : "Drag to resize, double-click to collapse"}
            >
              <div className="w-1.5 h-full group-hover:bg-primary/20 transition-colors" />
            </div>
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary resetKey={selectedId ?? undefined}>
                {displayRequest ? (
                  <RequestDetail
                    request={displayRequest}
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                    curlBtnRef={curlBtnRef}
                  />
                ) : (
                  <RequestDetailEmpty slug={currentEndpoint.slug} />
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
                    <RequestDetail
                      request={displayRequest}
                      activeTab={activeTab}
                      onTabChange={setActiveTab}
                    />
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
                totalCount={retainedTotalCount ?? undefined}
                methodFilter={methodFilter}
                onMethodFilterChange={setMethodFilter}
                searchQuery={searchInput}
                onSearchQueryChange={setSearchInput}
                onLoadMore={handleLoadMore}
                hasMore={showHasMore}
                loadingMore={loadingMore}
                searchLoading={searchLoading}
                searchError={searchError}
                searchInputRef={mobileSearchInputRef}
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
        className="neo-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
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
  const internalTestHeader = "X-Webhooks-CC-Test-Send";
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
        headers: {
          "Content-Type": "application/json",
          [internalTestHeader]: "1",
        },
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

        <p className="text-xs text-muted-foreground">
          Need signed provider templates? Use the{" "}
          <span className="font-bold text-foreground">Send</span> button in the URL bar or read{" "}
          <Link
            href="/docs/endpoints/test-webhooks"
            className="underline font-bold text-foreground"
          >
            dashboard test webhook docs
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function AutoCreateEndpoint({
  accessToken,
  onCreated,
}: {
  accessToken: string | null;
  onCreated: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (!accessToken || attempted.current) return;
    attempted.current = true;

    createDashboardEndpoint(accessToken, {})
      .then(() => onCreated())
      .catch(() => setError("Could not create your first endpoint."));
  }, [accessToken, onCreated]);

  const handleRetry = useCallback(() => {
    attempted.current = false;
    setError(null);
  }, []);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 border-2 border-foreground bg-muted flex items-center justify-center mx-auto mb-2">
            <Send className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-bold uppercase tracking-wide">No endpoints yet</h2>
          <p className="text-muted-foreground max-w-sm">{error}</p>
          <button onClick={handleRetry} className="neo-btn-primary">
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <p className="text-muted-foreground animate-pulse">Setting up your first endpoint...</p>
    </div>
  );
}
