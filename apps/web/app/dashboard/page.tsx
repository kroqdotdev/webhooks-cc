"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/providers/supabase-auth-provider";
import { cn } from "@/lib/utils";
import { EndpointBar, type EndpointTab } from "@/components/dashboard/endpoint-bar";
import {
  EndpointSettingsPanel,
  type SettingsSection,
} from "@/components/dashboard/endpoint-settings-panel";
import { RequestList } from "@/components/dashboard/request-list";
import {
  RequestDetail,
  RequestDetailEmpty,
  TABS,
  type Tab,
} from "@/components/dashboard/request-detail";
import { EmailDetail } from "@/components/dashboard/email-detail";
import { KeyboardShortcutsDialog } from "@/components/dashboard/keyboard-shortcuts-dialog";
import { RequestDiff } from "@/components/dashboard/request-diff";
import { RequestTimeline } from "@/components/dashboard/request-timeline";
import { getPinnedIds, togglePin } from "@/lib/pinned-requests";
import { getNote, setNote, getAllNotes } from "@/lib/request-notes";

import { ErrorBoundary } from "@/components/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Check, Send, Download, ChevronDown, Mail } from "lucide-react";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import { exportToJson, exportToCsv, downloadFile } from "@/lib/export";
import { trackRequestExported } from "@/lib/analytics";
import { subscribeToEndpointRequestChanges } from "@/lib/supabase/realtime";
import {
  fetchDashboardEndpoints,
  fetchDashboardRequests,
  fetchDashboardSearch,
  fetchDashboardSearchCount,
  subscribeDashboardEndpointsChanged,
  createDashboardEndpoint,
  claimGuestEndpointForUser,
  type DashboardEndpoint,
  sendTestEmail,
} from "@/lib/dashboard-api";
import {
  buildRetainedCountParams,
  computeShowHasMore,
  countLoadedAfter,
  incrementRetainedCount,
  matchesFilters,
  retainedCountCutoff,
} from "@/lib/dashboard-count";
import { createRefreshScheduler } from "@/lib/refresh-scheduler";
import type {
  ClickHouseRequest,
  ClickHouseSummary,
  AnyRequestSummary,
  Request,
} from "@/types/request";
import type { KindFilter } from "@/types/request";
import { toEmailSummary } from "@/lib/email-capture";

const CLICKHOUSE_PAGE_SIZE = 50;
const PANE_MIN = 240;
const PANE_DEFAULT = 384;
// Realtime refreshes: a short settle window lets a request insert and its
// signature update share one fetch, and bursts refresh at most once a second.
const REALTIME_SETTLE_MS = 150;
const REALTIME_MIN_INTERVAL_MS = 1000;
// The retained count follows arrivals in the browser. The server count is
// rate-limited per user, so while events flow it is re-read at most every
// COUNT_MIN_INTERVAL_MS (with a search active, where arrivals cannot be matched
// locally, or after more than a page arrived between refreshes), and otherwise
// every COUNT_RESYNC_INTERVAL_MS to drop requests that left retention.
const COUNT_MIN_INTERVAL_MS = 10_000;
const COUNT_RESYNC_INTERVAL_MS = 60_000;

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
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Pinning
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (currentSlug) setPinnedIds(getPinnedIds(currentSlug));
  }, [currentSlug]);
  const handleTogglePin = useCallback(
    (id: string) => {
      if (!currentSlug) return;
      setPinnedIds(togglePin(currentSlug, id));
    },
    [currentSlug]
  );

  // Notes
  const [noteIds, setNoteIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set<string>();
    return new Set(Object.keys(getAllNotes()));
  });
  const currentNote = selectedId ? getNote(selectedId) : null;
  const handleNoteChange = useCallback(
    (note: string) => {
      if (!selectedId) return;
      setNote(selectedId, note);
      // Rebuild from canonical store in case eviction pruned entries
      setNoteIds(new Set(Object.keys(getAllNotes())));
    },
    [selectedId]
  );

  // Compare mode — freeze both sides so live changes don't mutate the diff
  const [compareId, setCompareId] = useState<string | null>(null);
  const [compareRequest, setCompareRequest] = useState<ClickHouseRequest | null>(null);
  const [compareBase, setCompareBase] = useState<ClickHouseRequest | null>(null);
  const compareIdRef = useRef(compareId);
  // eslint-disable-next-line react-hooks/refs
  compareIdRef.current = compareId;
  const recentRequestsRef = useRef(recentRequests);
  // eslint-disable-next-line react-hooks/refs
  recentRequestsRef.current = recentRequests;

  const handleCompareSelect = useCallback(
    (id: string) => {
      if (compareIdRef.current === id) {
        setCompareId(null);
        setCompareRequest(null);
        setCompareBase(null);
      } else {
        setCompareId(id);
        // Snapshot the currently selected request as the frozen left side
        const base = displayRequestRef.current;
        if (base) {
          const baseId = "_id" in base ? base._id : base.id;
          setCompareBase({
            id: baseId,
            slug: currentSlug ?? "",
            method: base.method,
            path: base.path,
            headers: base.headers,
            body: base.body,
            queryParams: base.queryParams,
            contentType: base.contentType,
            ip: base.ip,
            size: base.size,
            receivedAt: base.receivedAt,
          });
        }
        const fromRecent = recentRequestsRef.current.find((r) => r._id === id);
        if (fromRecent) {
          setCompareRequest({
            id: fromRecent._id,
            slug: currentSlug ?? "",
            method: fromRecent.method,
            path: fromRecent.path,
            headers: fromRecent.headers,
            body: fromRecent.body,
            queryParams: fromRecent.queryParams,
            contentType: fromRecent.contentType,
            ip: fromRecent.ip,
            size: fromRecent.size,
            receivedAt: fromRecent.receivedAt,
          });
        } else {
          setCompareRequest(clickHouseDetailMap.current.get(id) ?? null);
        }
      }
    },
    [currentSlug]
  );

  const exitCompare = useCallback(() => {
    setCompareId(null);
    setCompareRequest(null);
    setCompareBase(null);
  }, []);

  useEffect(() => {
    if (!compareId) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") exitCompare();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [compareId, exitCompare]);

  // View mode (list vs timeline)
  const [viewMode, setViewMode] = useState<"list" | "timeline">("list");

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
  // eslint-disable-next-line react-hooks/refs
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
  // Requests already reflected in retainedTotalCount, and when the server
  // count was last requested.
  const countedRequestsRef = useRef<Request[]>([]);
  const lastCountRequestAtRef = useRef(0);
  const refreshRetainedCountRef = useRef<() => Promise<void>>(async () => {});
  const countSchedulerRef = useRef<ReturnType<typeof createRefreshScheduler> | null>(null);

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
      const response = await fetchDashboardEndpoints(accessToken);
      setEndpoints([...response.owned, ...response.shared]);
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

  // Older pages are fetched with the filters, so a filter change starts over.
  const prevListFilters = useRef(`${methodFilter}|${kindFilter}`);
  useEffect(() => {
    const filters = `${methodFilter}|${kindFilter}`;
    if (prevListFilters.current !== filters) {
      prevListFilters.current = filters;
      setOlderRequests([]);
      setHasMore(false);
      setHasLoadedOlderPage(false);
    }
  }, [methodFilter, kindFilter]);

  const handleKindFilterChange = useCallback((kind: KindFilter) => {
    setKindFilter(kind);
    // The method picker is hidden for email, so a method left over from HTTP
    // would hide every email with no way to clear it.
    if (kind === "email") setMethodFilter("ALL");
  }, []);

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
    if (kindFilter !== "all") params.kind = kindFilter;
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
    kindFilter,
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
      if (kindFilter !== "all") params.kind = kindFilter;

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
    [
      currentEndpoint,
      debouncedSearch,
      methodFilter,
      kindFilter,
      fetchFromClickHouse,
      storeClickHouseResults,
    ]
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
    lastCountRequestAtRef.current = Date.now();
    // Without a search, arrivals are added in the browser, so bound the server
    // count at the newest counted request and add whatever was counted past it
    // by the time the response lands. Counting both would double-count.
    const counted = countedRequestsRef.current;
    const cutoff =
      !debouncedSearch && counted[0]?.endpointId === currentEndpointId
        ? retainedCountCutoff(counted)
        : undefined;
    const params = buildRetainedCountParams(
      currentSlug,
      methodFilter,
      debouncedSearch,
      cutoff,
      kindFilter
    );

    const { count, ok } = await fetchCountFromClickHouse(params);
    if (requestSeq !== retainedCountRequestSeq.current) return;
    if (ok && count != null) {
      setRetainedTotalCount(
        cutoff === undefined
          ? count
          : count + countLoadedAfter(countedRequestsRef.current, cutoff, methodFilter, kindFilter)
      );
    }
  }, [
    currentSlug,
    currentEndpointId,
    methodFilter,
    kindFilter,
    debouncedSearch,
    fetchCountFromClickHouse,
  ]);

  useEffect(() => {
    refreshRetainedCountRef.current = refreshRetainedCount;
  }, [refreshRetainedCount]);

  useEffect(() => {
    const scheduler = createRefreshScheduler({
      run: () => void refreshRetainedCountRef.current(),
      settleMs: 0,
      minIntervalMs: COUNT_MIN_INTERVAL_MS,
    });
    countSchedulerRef.current = scheduler;
    return () => {
      scheduler.cancel();
      countSchedulerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!currentSlug || !accessToken) {
      retainedCountRequestSeq.current++;
      setRetainedTotalCount(null);
      return;
    }
    void refreshRetainedCount();
  }, [currentSlug, accessToken, methodFilter, kindFilter, debouncedSearch, refreshRetainedCount]);

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

    const scheduler = createRefreshScheduler({
      settleMs: REALTIME_SETTLE_MS,
      minIntervalMs: REALTIME_MIN_INTERVAL_MS,
      run: () => {
        void refreshRecentRequests();
        if (debouncedSearch) {
          void refreshSearchResults({ showLoading: false });
        }

        if (
          debouncedSearch ||
          Date.now() - lastCountRequestAtRef.current >= COUNT_RESYNC_INTERVAL_MS
        ) {
          countSchedulerRef.current?.schedule();
        }
      },
    });

    const unsubscribe = subscribeToEndpointRequestChanges(currentEndpointId, scheduler.schedule);
    return () => {
      scheduler.cancel();
      unsubscribe();
    };
  }, [currentEndpointId, debouncedSearch, refreshRecentRequests, refreshSearchResults]);

  const allItems = useMemo((): AnyRequestSummary[] => {
    if (debouncedSearch) {
      return searchResults.map((r): ClickHouseSummary => ({
        id: r.id,
        method: r.method,
        path: r.path,
        contentType: r.contentType,
        size: r.size,
        receivedAt: r.receivedAt,
        signatureVerified: r.signatureVerified,
        signatureError: r.signatureError,
        signingProvider: r.signingProvider,
        detectedProvider: r.detectedProvider,
        detectedEvent: r.detectedEvent,
        kind: r.kind,
        email: toEmailSummary(r.email ?? null),
      }));
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
        signatureVerified: request.signatureVerified,
        signatureError: request.signatureError,
        signingProvider: request.signingProvider,
        detectedProvider: request.detectedProvider,
        detectedEvent: request.detectedEvent,
        kind: request.kind,
        email: toEmailSummary(request.email ?? null),
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
        signatureVerified: r.signatureVerified,
        signatureError: r.signatureError,
        signingProvider: r.signingProvider,
        detectedProvider: r.detectedProvider,
        detectedEvent: r.detectedEvent,
        kind: r.kind,
        email: toEmailSummary(r.email ?? null),
      }));

    return [...recentSummaries, ...olderSummaries];
  }, [recentRequests, olderRequests, searchResults, debouncedSearch, methodFilter]);

  const displayedItems = useMemo(
    () =>
      kindFilter === "all"
        ? allItems
        : allItems.filter((item) => matchesFilters(item, "ALL", kindFilter)),
    [allItems, kindFilter]
  );

  useEffect(() => {
    if (recentRequests.length === 0) {
      prevTopSummaryId.current = null;
      countedRequestsRef.current = [];
      return;
    }

    const topId = recentRequests[0]._id;
    const previousTopId = prevTopSummaryId.current;

    // First snapshot for this endpoint: the count may have been read before
    // this list, so re-read it bounded at the snapshot. Later snapshots are
    // reconciled by the arrival increments below.
    if (!previousTopId && !debouncedSearch) {
      countedRequestsRef.current = recentRequests;
      void refreshRetainedCountRef.current();
    }

    if (previousTopId && topId !== previousTopId) {
      const previousIdx = recentRequests.findIndex((request) => request._id === previousTopId);
      const arrived = previousIdx >= 0 ? previousIdx : 1;

      if (arrived > 0) {
        // More than a page arrived when the previous top is gone: take the
        // whole page for now and let the server fill in the rest.
        const matching = recentRequests
          .slice(0, previousIdx >= 0 ? previousIdx : recentRequests.length)
          .filter((request) => matchesFilters(request, methodFilter, kindFilter));
        // Follow, or announce, only arrivals the list shows; the filters hide the rest.
        if (liveMode) {
          if (matching.length > 0) setSelectedId(matching[0]._id);
        } else if (matching.length > 0) {
          setNewCount((prev) => prev + matching.length);
        }

        if (!debouncedSearch) {
          setRetainedTotalCount((prev) => incrementRetainedCount(prev, matching.length));
          if (previousIdx === -1) {
            countSchedulerRef.current?.schedule();
          }
        }
      }
    }

    prevTopSummaryId.current = topId;
    countedRequestsRef.current = recentRequests;
  }, [recentRequests, liveMode, debouncedSearch, methodFilter, kindFilter]);

  // With nothing selected, select the newest request the list shows.
  useEffect(() => {
    if (selectedId || displayedItems.length === 0) return;
    const first = displayedItems[0];
    setSelectedId("_id" in first ? first._id : first.id);
  }, [displayedItems, selectedId]);

  useEffect(() => {
    setSelectedId(null);
    setSelectedClickHouseDetail(null);
    setNewCount(0);
    prevTopSummaryId.current = null;
    setMethodFilter("ALL");
    setKindFilter("all");
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

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileDetail(true);
  }, []);

  const handleToggleLiveMode = useCallback(() => setLiveMode((prev) => !prev), []);
  const handleToggleSort = useCallback(() => setSortNewest((prev) => !prev), []);

  const handleJumpToNew = useCallback(() => {
    // The newest request the list shows, which the filters may make older than the newest overall.
    const newest = displayedItems[0];
    if (newest) {
      setSelectedId("_id" in newest ? newest._id : newest.id);
      setNewCount(0);
    }
  }, [displayedItems]);

  const handleExportJson = useCallback(async () => {
    if (!currentEndpoint) return;
    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: "200",
      order: "desc",
    };
    if (methodFilter !== "ALL") params.method = methodFilter;
    if (kindFilter !== "all") params.kind = kindFilter;
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
  }, [currentEndpoint, methodFilter, kindFilter, debouncedSearch, fetchFromClickHouse]);

  const handleExportCsv = useCallback(async () => {
    if (!currentEndpoint) return;
    const params: Record<string, string> = {
      slug: currentEndpoint.slug,
      limit: "200",
      order: "desc",
    };
    if (methodFilter !== "ALL") params.method = methodFilter;
    if (kindFilter !== "all") params.kind = kindFilter;
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
  }, [currentEndpoint, methodFilter, kindFilter, debouncedSearch, fetchFromClickHouse]);

  // Keyboard shortcuts — use refs for frequently-changing values so the
  // listener doesn't re-register on every state change (rerender-dependencies).
  const displayedItemsRef = useRef(displayedItems);
  // eslint-disable-next-line react-hooks/refs
  displayedItemsRef.current = displayedItems;
  const selectedIdRef = useRef(selectedId);
  // eslint-disable-next-line react-hooks/refs
  selectedIdRef.current = selectedId;
  const displayRequestRef = useRef(displayRequest);
  // eslint-disable-next-line react-hooks/refs, react-hooks/immutability
  displayRequestRef.current = displayRequest;

  // A filter change can hide the selected request: drop it, and the effect
  // above selects the list's newest match instead.
  useEffect(() => {
    const id = selectedIdRef.current;
    if (!id) return;
    const visible = displayedItemsRef.current.some(
      (item) => ("_id" in item ? item._id : item.id) === id
    );
    if (!visible) setSelectedId(null);
  }, [methodFilter, kindFilter]);

  // Ref for cURL button (avoids DOM scraping in keyboard handler)
  const curlBtnRef = useRef<HTMLButtonElement>(null);
  // Requests or Settings; links elsewhere open Settings at the right section.
  const [endpointTab, setEndpointTab] = useState<EndpointTab>("requests");
  const [settingsFocus, setSettingsFocus] = useState<SettingsSection | null>(null);
  const handleOpenSettings = useCallback(() => {
    setSettingsFocus("verification");
    setEndpointTab("settings");
  }, []);
  const handleTabChange = useCallback((tab: EndpointTab) => {
    setSettingsFocus(null);
    setEndpointTab(tab);
  }, []);
  // A different endpoint starts on its requests.
  useEffect(() => {
    setEndpointTab("requests");
    setSettingsFocus(null);
  }, [currentEndpointId]);

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
        case "4":
        case "5": {
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

      <EndpointBar
        name={currentEndpoint.name || currentEndpoint.slug}
        slug={currentEndpoint.slug}
        emailAddress={currentEndpoint.emailAddress}
        tab={endpointTab}
        onTabChange={handleTabChange}
        hasRequests={hasRequests}
        exportMenu={
          hasRequests ? (
            <ExportDropdown onExportJson={handleExportJson} onExportCsv={handleExportCsv} />
          ) : undefined
        }
      />

      {/* Settings, the split pane, or the empty state */}
      {endpointTab === "settings" ? (
        <EndpointSettingsPanel
          key={currentEndpoint.id}
          endpoint={currentEndpoint}
          requestCount={retainedTotalCount ?? recentRequests.length}
          focusSection={settingsFocus}
        />
      ) : hasRequests ? (
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
                  pinnedIds={pinnedIds}
                  onTogglePin={handleTogglePin}
                  noteIds={noteIds}
                  compareId={compareId}
                  onCompareSelect={handleCompareSelect}
                  viewMode={viewMode}
                  onViewModeChange={setViewMode}
                  kindFilter={kindFilter}
                  onKindFilterChange={
                    currentEndpoint.emailAddress ? handleKindFilterChange : undefined
                  }
                  timelineSlot={
                    <RequestTimeline
                      requests={displayedItems}
                      selectedId={selectedId}
                      onSelect={handleSelect}
                    />
                  }
                />
              </div>
            )}
            {/* Drag handle / divider */}
            <div
              className="shrink-0 border-r-strong border-line relative group cursor-col-resize select-none"
              onMouseDown={handleDragStart}
              onDoubleClick={toggleCollapse}
              title={paneCollapsed ? "Expand sidebar" : "Drag to resize, double-click to collapse"}
            >
              <div className="w-1.5 h-full group-hover:bg-primary/20 transition-colors" />
            </div>
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary resetKey={selectedId ?? undefined}>
                {compareId && compareBase && compareRequest ? (
                  <RequestDiff left={compareBase} right={compareRequest} onExit={exitCompare} />
                ) : displayRequest?.kind === "email" ? (
                  <EmailDetail
                    key={selectedId ?? undefined}
                    request={displayRequest}
                    showExtracts={currentEndpoint.showEmailExtracts !== false}
                    note={currentNote}
                    onNoteChange={handleNoteChange}
                  />
                ) : displayRequest ? (
                  <RequestDetail
                    request={displayRequest}
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                    curlBtnRef={curlBtnRef}
                    note={currentNote}
                    onNoteChange={handleNoteChange}
                    onOpenSettings={handleOpenSettings}
                    endpointSlug={currentEndpoint.slug}
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
                  className="border-b-strong border-line px-4 py-2 text-sm font-bold caps hover:bg-muted cursor-pointer transition-colors shrink-0"
                >
                  &larr; Back to list
                </button>
                <div className="flex-1 overflow-hidden">
                  <ErrorBoundary resetKey={selectedId ?? undefined}>
                    {displayRequest.kind === "email" ? (
                      <EmailDetail
                        key={selectedId ?? undefined}
                        request={displayRequest}
                        showExtracts={currentEndpoint.showEmailExtracts !== false}
                        note={currentNote}
                        onNoteChange={handleNoteChange}
                      />
                    ) : (
                      <RequestDetail
                        request={displayRequest}
                        activeTab={activeTab}
                        onTabChange={setActiveTab}
                        note={currentNote}
                        onNoteChange={handleNoteChange}
                        onOpenSettings={handleOpenSettings}
                        endpointSlug={currentEndpoint.slug}
                      />
                    )}
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
                pinnedIds={pinnedIds}
                onTogglePin={handleTogglePin}
                noteIds={noteIds}
                kindFilter={kindFilter}
                onKindFilterChange={
                  currentEndpoint.emailAddress ? handleKindFilterChange : undefined
                }
              />
            )}
          </div>
        </>
      ) : (
        <WaitingForRequests
          slug={currentEndpoint.slug}
          emailAddress={currentEndpoint.emailAddress ?? null}
        />
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
        aria-label="Export"
        aria-expanded={open}
        className="ui-btn-outline py-1.5! px-3! text-xs flex items-center gap-1.5"
      >
        <Download className="h-3.5 w-3.5" />
        {/* Icon only on phones, where the endpoint bar is narrow. */}
        <span className="hidden sm:inline">Export</span>
        <ChevronDown className="h-3 w-3 hidden sm:block" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 overflow-hidden rounded-lg border-strong border-line bg-background shadow-raised z-50 min-w-[140px]">
          <button
            onClick={() => {
              onExportJson();
              setOpen(false);
            }}
            className="w-full px-3 py-2 text-left text-xs font-bold caps hover:bg-muted cursor-pointer transition-colors border-b-strong border-line"
          >
            Export JSON
          </button>
          <button
            onClick={() => {
              onExportCsv();
              setOpen(false);
            }}
            className="w-full px-3 py-2 text-left text-xs font-bold caps hover:bg-muted cursor-pointer transition-colors"
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
      <div className="border-b-strong border-line bg-card px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-5 flex-1 max-w-md" />
        </div>
      </div>
      {/* Content skeleton */}
      <div className="flex-1 flex">
        {/* List skeleton */}
        <div className="w-80 shrink-0 border-r-strong border-line hidden md:block">
          <div className="border-b-strong border-line px-3 py-2">
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

function CopyLabel({ done }: { done: boolean }) {
  return done ? (
    <>
      <Check className="h-3 w-3" /> Copied
    </>
  ) : (
    <>
      <Copy className="h-3 w-3" /> Copy
    </>
  );
}

function WaitingForRequests({ slug, emailAddress }: { slug: string; emailAddress: string | null }) {
  const internalTestHeader = "X-Webhooks-CC-Test-Send";
  const { session } = useAuth();
  const [copied, setCopied] = useState<"curl" | "email" | null>(null);
  const [sending, setSending] = useState<"http" | "email" | null>(null);
  const [sent, setSent] = useState<"http" | "email" | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
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

  const handleCopy = async (text: string, key: "curl" | "email") => {
    if (!(await copyToClipboard(text))) return;
    setCopied(key);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(null), 2000);
  };

  const markSent = (kind: "http" | "email") => {
    setSent(kind);
    if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
    sentTimeoutRef.current = setTimeout(() => setSent(null), 3000);
  };

  const handleSendTest = async () => {
    setSending("http");
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [internalTestHeader]: "1",
        },
        body: JSON.stringify({ test: true, sentAt: new Date().toISOString() }),
      });
    } catch {
      // Might be CORS; the request still reaches the receiver.
    } finally {
      markSent("http");
      setSending(null);
    }
  };

  const handleSendEmail = async () => {
    if (!session?.access_token) return;
    setSending("email");
    setEmailError(null);
    try {
      await sendTestEmail(session.access_token, slug);
      markSent("email");
    } catch (error) {
      setEmailError(error instanceof Error ? error.message : "The test email failed.");
    } finally {
      setSending(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto flex items-center justify-center p-6 md:p-8">
      <div className={cn("w-full space-y-6", emailAddress ? "max-w-4xl" : "max-w-lg")}>
        <div className="flex items-center justify-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 motion-reduce:hidden" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-primary" />
          </span>
          <p className="font-bold caps">Waiting for the first request</p>
        </div>

        <div className={cn("grid gap-4", emailAddress && "md:grid-cols-2")}>
          <div className="ui-card ui-card-static p-5! flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="font-bold">Send an HTTP request</p>
              <button
                onClick={() => void handleCopy(curlCmd, "curl")}
                className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1 transition-colors"
              >
                <CopyLabel done={copied === "curl"} />
              </button>
            </div>
            <pre className="ui-code text-sm whitespace-pre-wrap break-all text-left shadow-none!">
              {curlCmd}
            </pre>
            <button
              onClick={() => void handleSendTest()}
              disabled={sending === "http"}
              className="ui-btn-primary self-start flex items-center gap-2 py-2! px-4! text-sm"
            >
              <Send className="h-4 w-4" />
              {sending === "http" ? "Sending..." : sent === "http" ? "Sent" : "Send test request"}
            </button>
          </div>

          {emailAddress && (
            <div className="ui-card ui-card-static p-5! flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="font-bold">Send an email</p>
                <button
                  onClick={() => void handleCopy(emailAddress, "email")}
                  className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1 transition-colors"
                >
                  <CopyLabel done={copied === "email"} />
                </button>
              </div>
              <pre className="ui-code text-sm whitespace-pre-wrap break-all text-left shadow-none!">
                {emailAddress}
              </pre>
              <p className="text-xs text-muted-foreground">
                Put this address in your app&apos;s signup form, or send to it from any mail client.
              </p>
              <button
                onClick={() => void handleSendEmail()}
                disabled={sending === "email"}
                className="ui-btn-outline self-start flex items-center gap-2 py-2! px-4! text-sm"
              >
                <Mail className="h-4 w-4" />
                {sending === "email" ? "Sending..." : sent === "email" ? "Sent" : "Send test email"}
              </button>
              {emailError && <p className="text-xs text-destructive">{emailError}</p>}
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground text-center">
          Need signed provider templates? Use{" "}
          <span className="font-bold text-foreground">Send</span> above, or read the{" "}
          <Link
            href="/docs/endpoints/test-webhooks"
            className="underline font-bold text-foreground"
          >
            test webhook docs
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
          <div className="w-16 h-16 rounded-md border-strong border-line bg-muted flex items-center justify-center mx-auto mb-2">
            <Send className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-bold caps">No endpoints yet</h2>
          <p className="text-muted-foreground max-w-sm">{error}</p>
          <button onClick={handleRetry} className="ui-btn-primary">
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
