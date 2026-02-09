"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { UrlBar } from "@/components/dashboard/url-bar";
import { RequestList } from "@/components/dashboard/request-list";
import { RequestDetail, RequestDetailEmpty } from "@/components/dashboard/request-detail";
import { ErrorBoundary } from "@/components/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Check, Send, Download, ChevronDown } from "lucide-react";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import { exportToJson, exportToCsv, downloadFile } from "@/lib/export";
import type { RequestSummary } from "@/types/request";

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

  const [selectedId, setSelectedId] = useState<Id<"requests"> | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [sortNewest, setSortNewest] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(false);
  const prevRequestCount = useRef(0);
  const [newCount, setNewCount] = useState(0);
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pendingExport, setPendingExport] = useState<"json" | "csv" | null>(null);

  // Debounce search to avoid rapid Convex subscription churn
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (searchInput === "") {
      setDebouncedSearch("");
      return;
    }
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(searchDebounceRef.current);
  }, [searchInput]);

  // Full request list — only subscribed when debounced search is active or export is pending
  const needsFullList = debouncedSearch.length > 0 || pendingExport !== null;
  const fullRequests = useQuery(
    api.requests.list,
    needsFullList && currentEndpoint
      ? { endpointId: currentEndpoint._id, limit: 50 }
      : "skip"
  );

  // Full detail for selected request
  const selectedRequest = useQuery(
    api.requests.get,
    selectedId ? { id: selectedId } : "skip"
  );

  // Request count from the endpoint doc (denormalized)
  const requestCount = currentEndpoint?.requestCount ?? 0;

  // Cache last loaded request to prevent flicker during selection changes
  const lastLoadedRequest = useRef<typeof selectedRequest>(undefined);
  useEffect(() => {
    if (selectedRequest !== undefined) {
      lastLoadedRequest.current = selectedRequest;
    }
  }, [selectedRequest]);

  // Clear stale selectedId when the request no longer exists (e.g. cleaned up)
  useEffect(() => {
    if (selectedRequest === null && selectedId) {
      setSelectedId(null);
    }
  }, [selectedRequest, selectedId]);

  // Show previous request while new one loads (prevents flicker)
  const displayRequest = selectedRequest !== undefined ? selectedRequest : lastLoadedRequest.current;

  // Filter full requests for export (respects active method + search filters)
  const filterFullRequests = useCallback((requests: NonNullable<typeof fullRequests>) => {
    return requests.filter((r) => {
      if (methodFilter !== "ALL" && r.method !== methodFilter) return false;
      if (searchInput) {
        const q = searchInput.toLowerCase();
        return r.path.toLowerCase().includes(q)
          || (r.body?.toLowerCase().includes(q) ?? false)
          || r._id.toLowerCase().includes(q);
      }
      return true;
    });
  }, [methodFilter, searchInput]);

  // Handle export when full data arrives
  useEffect(() => {
    if (!pendingExport || !fullRequests) return;
    const filtered = filterFullRequests(fullRequests);
    if (pendingExport === "json") {
      downloadFile(exportToJson(filtered), "webhooks-export.json", "application/json");
    } else {
      downloadFile(exportToCsv(filtered), "webhooks-export.csv", "text/csv");
    }
    setPendingExport(null);
  }, [pendingExport, fullRequests, filterFullRequests]);

  // Client-side filtering on summaries (method filter only)
  // When search is active, filter the full requests and map back to summaries
  const filteredSummaries = useMemo(() => {
    if (searchInput) {
      // Search active but full data not loaded yet — show empty to prevent unfiltered flash
      if (!fullRequests) return [];
      const q = searchInput.toLowerCase();
      return fullRequests
        .filter((r) => {
          if (methodFilter !== "ALL" && r.method !== methodFilter) return false;
          const matchesPath = r.path.toLowerCase().includes(q);
          const matchesBody = r.body?.toLowerCase().includes(q) ?? false;
          const matchesId = r._id.toLowerCase().includes(q);
          return matchesPath || matchesBody || matchesId;
        })
        .map((r): RequestSummary => ({
          _id: r._id,
          _creationTime: r._creationTime,
          method: r.method,
          receivedAt: r.receivedAt,
        }));
    }
    if (!summaries) return [];
    if (methodFilter === "ALL") return summaries;
    return summaries.filter((r) => r.method === methodFilter);
  }, [summaries, fullRequests, methodFilter, searchInput]);

  // Track incoming requests for live mode
  useEffect(() => {
    if (!summaries) return;

    const currentCount = summaries.length;
    const diff = currentCount - prevRequestCount.current;

    if (prevRequestCount.current > 0 && diff > 0) {
      if (liveMode) {
        if (filteredSummaries.length > 0) {
          setSelectedId(filteredSummaries[0]._id);
        }
      } else {
        setNewCount((prev) => prev + diff);
      }
    }

    prevRequestCount.current = currentCount;
  }, [summaries, liveMode, filteredSummaries]);

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
    setNewCount(0);
    prevRequestCount.current = 0;
    setMethodFilter("ALL");
    setSearchInput("");
    setDebouncedSearch("");
    setPendingExport(null);
    lastLoadedRequest.current = undefined;
  }, [currentEndpointId]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id as Id<"requests">);
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

  const handleExportJson = useCallback(() => {
    if (fullRequests) {
      const filtered = filterFullRequests(fullRequests);
      downloadFile(exportToJson(filtered), "webhooks-export.json", "application/json");
    } else {
      setPendingExport("json");
    }
  }, [fullRequests, filterFullRequests]);

  const handleExportCsv = useCallback(() => {
    if (fullRequests) {
      const filtered = filterFullRequests(fullRequests);
      downloadFile(exportToCsv(filtered), "webhooks-export.csv", "text/csv");
    } else {
      setPendingExport("csv");
    }
  }, [fullRequests, filterFullRequests]);

  if (endpoints === undefined) {
    return <DashboardSkeleton />;
  }

  if (endpoints.length === 0) {
    return <EmptyEndpoints />;
  }

  if (!currentEndpoint) return null;

  const hasRequests = summaries && summaries.length > 0;

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
                requests={filteredSummaries}
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
                requests={filteredSummaries}
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
