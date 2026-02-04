"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@convex/_generated/api";
import { UrlBar } from "@/components/dashboard/url-bar";
import { RequestList } from "@/components/dashboard/request-list";
import { RequestDetail, RequestDetailEmpty } from "@/components/dashboard/request-detail";
import { ErrorBoundary } from "@/components/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Check, Send, Download, ChevronDown } from "lucide-react";
import { WEBHOOK_BASE_URL } from "@/lib/constants";
import { copyToClipboard } from "@/lib/clipboard";
import { exportToJson, exportToCsv, downloadFile } from "@/lib/export";
import type { Request } from "@/types/request";

export default function DashboardPage() {
  const endpoints = useQuery(api.endpoints.list);
  const searchParams = useSearchParams();
  const endpointSlug = searchParams.get("endpoint");

  const currentEndpoint = endpoints?.find((ep) => ep.slug === endpointSlug) ?? endpoints?.[0];

  const requests = useQuery(
    api.requests.list,
    currentEndpoint ? { endpointId: currentEndpoint._id, limit: 50 } : "skip"
  );

  const requestCount = useQuery(
    api.requests.count,
    currentEndpoint ? { endpointId: currentEndpoint._id } : "skip"
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [sortNewest, setSortNewest] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(false);
  const prevRequestCount = useRef(0);
  const [newCount, setNewCount] = useState(0);
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  // Client-side filtering
  const filteredRequests = useMemo(() => {
    if (!requests) return [];
    return requests.filter((r: Request) => {
      if (methodFilter !== "ALL" && r.method !== methodFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchesPath = r.path.toLowerCase().includes(q);
        const matchesBody = r.body?.toLowerCase().includes(q) ?? false;
        const matchesId = r._id.toLowerCase().includes(q);
        if (!matchesPath && !matchesBody && !matchesId) return false;
      }
      return true;
    });
  }, [requests, methodFilter, searchQuery]);

  // Track incoming requests for live mode
  useEffect(() => {
    if (!requests) return;

    const currentCount = requests.length;
    const diff = currentCount - prevRequestCount.current;

    if (prevRequestCount.current > 0 && diff > 0) {
      if (liveMode) {
        // Auto-select newest visible request (respects active filters)
        if (filteredRequests.length > 0) {
          setSelectedId(filteredRequests[0]._id);
        }
      } else {
        // Show "N new" banner
        setNewCount((prev) => prev + diff);
      }
    }

    prevRequestCount.current = currentCount;
  }, [requests, liveMode, filteredRequests]);

  // Auto-select first request when requests load and nothing is selected
  useEffect(() => {
    if (requests && requests.length > 0 && !selectedId) {
      setSelectedId(requests[0]._id);
    }
  }, [requests, selectedId]);

  // Reset state when endpoint changes
  const currentEndpointId = currentEndpoint?._id;
  useEffect(() => {
    setSelectedId(null);
    setNewCount(0);
    prevRequestCount.current = 0;
    setMethodFilter("ALL");
    setSearchQuery("");
  }, [currentEndpointId]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileDetail(true);
  }, []);

  const handleToggleLiveMode = useCallback(() => setLiveMode((prev) => !prev), []);
  const handleToggleSort = useCallback(() => setSortNewest((prev) => !prev), []);

  const handleJumpToNew = useCallback(() => {
    if (requests && requests.length > 0) {
      setSelectedId(requests[0]._id);
      setNewCount(0);
    }
  }, [requests]);

  const handleExportJson = useCallback(() => {
    const data = exportToJson(filteredRequests);
    downloadFile(data, "webhooks-export.json", "application/json");
  }, [filteredRequests]);

  const handleExportCsv = useCallback(() => {
    const data = exportToCsv(filteredRequests);
    downloadFile(data, "webhooks-export.csv", "text/csv");
  }, [filteredRequests]);

  if (endpoints === undefined) {
    return <DashboardSkeleton />;
  }

  if (endpoints.length === 0) {
    return <EmptyEndpoints />;
  }

  if (!currentEndpoint) return null;

  const selectedRequest = filteredRequests.find((r) => r._id === selectedId) ?? null;
  const hasRequests = requests && requests.length > 0;

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
                requests={filteredRequests}
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
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
              />
            </div>
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary resetKey={selectedId ?? undefined}>
                {selectedRequest ? (
                  <RequestDetail request={selectedRequest} />
                ) : (
                  <RequestDetailEmpty />
                )}
              </ErrorBoundary>
            </div>
          </div>

          {/* Mobile: list or detail */}
          <div className="md:hidden flex-1 overflow-hidden flex flex-col">
            {mobileDetail && selectedRequest ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <button
                  onClick={() => setMobileDetail(false)}
                  className="border-b-2 border-foreground px-4 py-2 text-sm font-bold uppercase tracking-wide hover:bg-muted cursor-pointer transition-colors shrink-0"
                >
                  &larr; Back to list
                </button>
                <div className="flex-1 overflow-hidden">
                  <ErrorBoundary resetKey={selectedId ?? undefined}>
                    <RequestDetail request={selectedRequest} />
                  </ErrorBoundary>
                </div>
              </div>
            ) : (
              <RequestList
                requests={filteredRequests}
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
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
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
