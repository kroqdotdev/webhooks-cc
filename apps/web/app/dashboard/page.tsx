"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@convex/_generated/api";
import { UrlBar } from "@/components/dashboard/url-bar";
import { RequestList } from "@/components/dashboard/request-list";
import { RequestDetail, RequestDetailEmpty } from "@/components/dashboard/request-detail";
import { Copy, Check, Send } from "lucide-react";
import { WEBHOOK_BASE_URL } from "@/lib/constants";

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

  // Track incoming requests for live mode
  useEffect(() => {
    if (!requests) return;

    const currentCount = requests.length;
    const diff = currentCount - prevRequestCount.current;

    if (prevRequestCount.current > 0 && diff > 0) {
      if (liveMode) {
        // Auto-select newest
        setSelectedId(requests[0]._id);
      } else {
        // Show "N new" banner
        setNewCount((prev) => prev + diff);
      }
    }

    prevRequestCount.current = currentCount;
  }, [requests, liveMode]);

  // Auto-select first request when requests load and nothing is selected
  useEffect(() => {
    if (requests && requests.length > 0 && !selectedId) {
      setSelectedId(requests[0]._id);
    }
  }, [requests, selectedId]);

  // Reset state when endpoint changes
  useEffect(() => {
    setSelectedId(null);
    setNewCount(0);
    prevRequestCount.current = 0;
  }, [currentEndpoint?._id]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileDetail(true);
  }, []);

  const handleJumpToNew = useCallback(() => {
    if (requests && requests.length > 0) {
      setSelectedId(requests[0]._id);
      setNewCount(0);
    }
  }, [requests]);

  if (endpoints === undefined) {
    return (
      <div className="flex items-center justify-center flex-1">
        <div className="animate-pulse text-muted-foreground font-bold uppercase tracking-wide text-sm">
          Loading...
        </div>
      </div>
    );
  }

  if (endpoints.length === 0) {
    return <EmptyEndpoints />;
  }

  if (!currentEndpoint) return null;

  const selectedRequest = requests?.find((r) => r._id === selectedId) ?? null;
  const hasRequests = requests && requests.length > 0;

  return (
    <>
      {/* URL Bar */}
      <UrlBar
        endpointId={currentEndpoint._id}
        endpointName={currentEndpoint.name || currentEndpoint.slug}
        slug={currentEndpoint.slug}
        mockResponse={currentEndpoint.mockResponse}
      />

      {/* Split pane or empty state */}
      {hasRequests ? (
        <>
          {/* Desktop: side-by-side */}
          <div className="hidden md:flex flex-1 overflow-hidden">
            <div className="w-80 shrink-0 border-r-2 border-foreground overflow-hidden">
              <RequestList
                requests={requests}
                selectedId={selectedId}
                onSelect={handleSelect}
                liveMode={liveMode}
                onToggleLiveMode={() => setLiveMode(!liveMode)}
                sortNewest={sortNewest}
                onToggleSort={() => setSortNewest(!sortNewest)}
                newCount={newCount}
                onJumpToNew={handleJumpToNew}
                totalCount={requestCount}
              />
            </div>
            <div className="flex-1 overflow-hidden">
              {selectedRequest ? (
                <RequestDetail request={selectedRequest} />
              ) : (
                <RequestDetailEmpty />
              )}
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
                  <RequestDetail request={selectedRequest} />
                </div>
              </div>
            ) : (
              <RequestList
                requests={requests}
                selectedId={selectedId}
                onSelect={handleSelect}
                liveMode={liveMode}
                onToggleLiveMode={() => setLiveMode(!liveMode)}
                sortNewest={sortNewest}
                onToggleSort={() => setSortNewest(!sortNewest)}
                newCount={newCount}
                onJumpToNew={handleJumpToNew}
                totalCount={requestCount}
              />
            )}
          </div>
        </>
      ) : (
        <WaitingForRequests slug={currentEndpoint.slug} />
      )}
    </>
  );
}

function WaitingForRequests({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const url = `${WEBHOOK_BASE_URL}/w/${slug}`;
  const curlCmd = `curl -X POST ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"test": true}'`;

  const handleCopy = () => {
    navigator.clipboard.writeText(curlCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
      setTimeout(() => setSent(false), 3000);
    } catch {
      // Ignore - might be CORS, request still reaches the receiver
      setSent(true);
      setTimeout(() => setSent(false), 3000);
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
      <div className="text-center space-y-2">
        <h2 className="text-xl font-bold uppercase tracking-wide">No endpoints yet</h2>
        <p className="text-muted-foreground">
          Click <span className="font-bold text-foreground">"New Endpoint"</span> above to get started!
        </p>
      </div>
    </div>
  );
}
