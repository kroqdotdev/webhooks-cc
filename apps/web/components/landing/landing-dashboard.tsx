"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { getWebhookUrl } from "@/lib/constants";
import { ErrorBoundary } from "@/components/error-boundary";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import {
  createGuestDashboardEndpoint,
  fetchGuestDashboardEndpoint,
  fetchGuestDashboardRequests,
  normalizeGuestEndpoint,
  type GuestEndpointRecord,
} from "@/lib/go-dashboard";
import { parseStoredDemoEndpoint } from "@/lib/go-demo-storage";
import { subscribeToEndpointRow, subscribeToEndpointRequestChanges } from "@/lib/supabase/realtime";
import { buildTemplateRequest } from "@/lib/template-send";
import type { Request, RequestSummary } from "@/types/request";
import { trackCTAClick, trackGuestEndpointCreated } from "@/lib/analytics";
import { ArrowRight, Check, Circle, Copy, Send } from "lucide-react";

const REQUEST_LIMIT = 25;
const DEMO_ENDPOINT_STORAGE_KEY = "demo_endpoint";
const INTERNAL_TEST_SEND_HEADER = "X-Webhooks-CC-Test-Send";
const DEMO_PROVIDER_SECRET = "mock_webhook_secret";
// Local fallback so refreshes immediately after create still restore the slug.
const EXPIRY_MS = 12 * 60 * 60 * 1000;
const COPY_FEEDBACK_MS = 2000;
const SEND_FEEDBACK_MS = 3000;
const SYNC_INTERVAL_MS = 2000;

const RequestList = dynamic(
  () => import("@/components/dashboard/request-list").then((module) => module.RequestList),
  { ssr: false, loading: () => <PaneLoading label="Loading requests..." /> }
);
const RequestDetail = dynamic(
  () => import("@/components/dashboard/request-detail").then((module) => module.RequestDetail),
  { ssr: false, loading: () => <PaneLoading label="Loading request..." /> }
);
const RequestDetailEmpty = dynamic(
  () => import("@/components/dashboard/request-detail").then((module) => module.RequestDetailEmpty),
  { ssr: false, loading: () => <PaneLoading label="Loading request..." /> }
);

function PaneLoading({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center text-xs font-bold uppercase tracking-wide text-muted-foreground">
      {label}
    </div>
  );
}

function formatRemainingTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function LandingDashboard() {
  return (
    <SupabaseAuthProvider>
      <LandingDashboardInner />
    </SupabaseAuthProvider>
  );
}

function LandingDashboardInner() {
  const { isAuthenticated, isLoading } = useAuth();

  const [endpointSlug, setEndpointSlug] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<GuestEndpointRecord | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [upgradeDismissed, setUpgradeDismissed] = useState(false);

  // Dashboard pane state — mirrors the /go inspector
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [sortNewest, setSortNewest] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const prevRequestCount = useRef(0);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (searchInput === "") {
      setDebouncedSearch("");
      return;
    }
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(searchDebounceRef.current);
  }, [searchInput]);

  const clearDemoEndpoint = useCallback((nextError: string | null = null) => {
    setEndpointSlug(null);
    setEndpoint(null);
    setRequests([]);
    setExpiresAt(null);
    setTimeRemaining(null);
    setSelectedId(null);
    setMobileDetail(false);
    setNewCount(0);
    setMethodFilter("ALL");
    setSearchInput("");
    setDebouncedSearch("");
    setCreateError(nextError);
    prevRequestCount.current = 0;
    if (typeof window !== "undefined") {
      localStorage.removeItem(DEMO_ENDPOINT_STORAGE_KEY);
    }
  }, []);

  const refreshEndpoint = useCallback(async (slug: string) => {
    try {
      const next = await fetchGuestDashboardEndpoint(slug);
      if (!next) return;
      setEndpoint(next);
      if (next.expiresAt) {
        setExpiresAt(next.expiresAt);
        localStorage.setItem(
          DEMO_ENDPOINT_STORAGE_KEY,
          JSON.stringify({ slug: next.slug, expiresAt: next.expiresAt })
        );
      }
    } catch (error) {
      console.error("Failed to load guest endpoint:", error);
    }
  }, []);

  const refreshRequests = useCallback(async (slug: string) => {
    try {
      setRequests(await fetchGuestDashboardRequests(slug, REQUEST_LIMIT));
    } catch (error) {
      console.error("Failed to load guest requests:", error);
    }
  }, []);

  const handleCreateEndpoint = useCallback(async () => {
    setIsCreating(true);
    setCreateError(null);
    try {
      const result = await createGuestDashboardEndpoint();
      const expiry = result.expiresAt ?? Date.now() + EXPIRY_MS;
      trackGuestEndpointCreated();
      setEndpointSlug(result.slug);
      setEndpoint(result);
      setRequests([]);
      setExpiresAt(expiry);
      setSelectedId(null);
      localStorage.setItem(
        DEMO_ENDPOINT_STORAGE_KEY,
        JSON.stringify({ slug: result.slug, expiresAt: expiry })
      );
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "";
      if (
        rawMessage.includes("Too many requests") ||
        rawMessage.includes("Too many active demo endpoints")
      ) {
        setCreateError(rawMessage);
      } else {
        setCreateError("Something went wrong. Please try again.");
      }
    } finally {
      setIsCreating(false);
    }
  }, []);

  // Restore a stored endpoint on mount so refreshes and /go visits share the same URL.
  useEffect(() => {
    try {
      const stored = parseStoredDemoEndpoint(localStorage.getItem(DEMO_ENDPOINT_STORAGE_KEY));
      if (stored) {
        setEndpointSlug(stored.slug);
        setExpiresAt(stored.expiresAt);
      }
    } finally {
      setStorageReady(true);
    }
  }, []);

  // Auto-create a guest endpoint the moment a signed-out visitor lands.
  // The ref gates this to a single attempt — handleCreateEndpoint is stable (useCallback, []).
  const autoCreateAttempted = useRef(false);
  useEffect(() => {
    if (!storageReady || isLoading || endpointSlug || autoCreateAttempted.current) return;
    if (isAuthenticated) return;
    autoCreateAttempted.current = true;
    void handleCreateEndpoint();
  }, [storageReady, isLoading, endpointSlug, isAuthenticated, handleCreateEndpoint]);

  useEffect(() => {
    if (!endpointSlug) return;
    void refreshEndpoint(endpointSlug);
    void refreshRequests(endpointSlug);
  }, [endpointSlug, refreshEndpoint, refreshRequests]);

  // Countdown until the guest endpoint expires.
  useEffect(() => {
    if (!expiresAt) {
      setTimeRemaining(null);
      return;
    }
    const updateTimer = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        clearDemoEndpoint("Your test endpoint expired. Create a new one.");
        return;
      }
      setTimeRemaining(formatRemainingTime(remaining));
    };
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [clearDemoEndpoint, expiresAt]);

  // Realtime updates, with a light poll as fallback for anon realtime gaps.
  useEffect(() => {
    if (!endpoint?.id || !endpointSlug) return;

    const unsubscribeEndpoint = subscribeToEndpointRow(endpoint.id, (row) => {
      if (!row) {
        clearDemoEndpoint("Your test endpoint expired. Create a new one.");
        return;
      }
      setEndpoint(normalizeGuestEndpoint(row));
      void refreshRequests(endpointSlug);
    });
    const unsubscribeRequests = subscribeToEndpointRequestChanges(endpoint.id, () => {
      void refreshRequests(endpointSlug);
      void refreshEndpoint(endpointSlug);
    });
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshEndpoint(endpointSlug);
      void refreshRequests(endpointSlug);
    }, SYNC_INTERVAL_MS);

    return () => {
      unsubscribeEndpoint();
      unsubscribeRequests();
      window.clearInterval(interval);
    };
  }, [clearDemoEndpoint, endpoint?.id, endpointSlug, refreshEndpoint, refreshRequests]);

  // Live mode: select newly arrived requests automatically, or count them.
  useEffect(() => {
    if (requests.length === 0) {
      prevRequestCount.current = 0;
      return;
    }
    const diff = requests.length - prevRequestCount.current;
    if (prevRequestCount.current > 0 && diff > 0) {
      if (liveMode) {
        setSelectedId(requests[0]?._id ?? null);
      } else {
        setNewCount((prev) => prev + diff);
      }
    }
    prevRequestCount.current = requests.length;
  }, [requests, liveMode]);

  useEffect(() => {
    if (requests.length > 0 && !selectedId) {
      setSelectedId(requests[0]!._id);
    }
  }, [requests, selectedId]);

  useEffect(() => {
    if (selectedId && !requests.some((request) => request._id === selectedId)) {
      setSelectedId(null);
    }
  }, [requests, selectedId]);

  const filteredSummaries = useMemo(() => {
    const matchesFilters = (r: Request) => {
      if (methodFilter !== "ALL" && r.method !== methodFilter) return false;
      if (!debouncedSearch) return true;
      const q = debouncedSearch.toLowerCase();
      return (
        r.path.toLowerCase().includes(q) ||
        (r.body?.toLowerCase().includes(q) ?? false) ||
        r._id.toLowerCase().includes(q)
      );
    };
    return requests.filter(matchesFilters).map(
      (r): RequestSummary => ({
        _id: r._id,
        _creationTime: r._creationTime,
        method: r.method,
        path: r.path,
        contentType: r.contentType,
        size: r.size,
        receivedAt: r.receivedAt,
        detectedProvider: r.detectedProvider,
        detectedEvent: r.detectedEvent,
      })
    );
  }, [requests, methodFilter, debouncedSearch]);

  const displayDetail = useMemo(
    () => requests.find((request) => request._id === selectedId),
    [requests, selectedId]
  );

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileDetail(true);
  }, []);
  const handleToggleLiveMode = useCallback(() => setLiveMode((prev) => !prev), []);
  const handleToggleSort = useCallback(() => setSortNewest((prev) => !prev), []);
  const handleJumpToNew = useCallback(() => {
    if (requests.length === 0) return;
    setSelectedId(requests[0]!._id);
    setNewCount(0);
  }, [requests]);

  const endpointUrl = endpointSlug ? getWebhookUrl(endpointSlug) : null;
  const requestCount = Math.max(endpoint?.requestCount ?? 0, requests.length);
  const remainingRequests = Math.max(0, REQUEST_LIMIT - requestCount);
  const hasRequests = requests.length > 0;

  // Signed-in visitors already have persistent endpoints — send them there.
  if (isAuthenticated) {
    return (
      <DashboardFrame>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-lg font-bold">You&apos;re signed in</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            Your persistent endpoints live in the dashboard — guest URLs are for first-time
            visitors.
          </p>
          <Link href="/dashboard" className="neo-btn-primary inline-block">
            Go to dashboard
            <ArrowRight className="inline-block ml-2 h-4 w-4" />
          </Link>
        </div>
      </DashboardFrame>
    );
  }

  if (createError) {
    return (
      <DashboardFrame>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-lg font-bold">Couldn&apos;t create your webhook URL</p>
          <p className="text-sm text-muted-foreground max-w-sm">{createError}</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void handleCreateEndpoint()}
              disabled={isCreating}
              className="neo-btn-primary"
            >
              {isCreating ? "Creating..." : "Try again"}
            </button>
            <Link href="/login" className="neo-btn-secondary">
              Sign up free instead
            </Link>
          </div>
        </div>
      </DashboardFrame>
    );
  }

  if (!endpointUrl) {
    return (
      <DashboardFrame>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <span
            className="h-3 w-3 bg-primary border-2 border-foreground animate-pulse motion-reduce:animate-none"
            aria-hidden
          />
          <p className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
            Creating your webhook URL...
          </p>
        </div>
      </DashboardFrame>
    );
  }

  return (
    <DashboardFrame>
      <ErrorBoundary resetKey={endpoint?.id}>
        {/* URL bar — same layout as the real dashboard */}
        <div className="shrink-0 border-b-2 border-foreground bg-card px-4 py-2.5 flex items-center gap-3">
          <span className="font-bold text-sm uppercase tracking-wide shrink-0 hidden sm:inline">
            Your endpoint
          </span>
          <UrlCopy url={endpointUrl} />
          <div className="hidden md:flex items-center gap-4 shrink-0 text-xs text-muted-foreground ml-auto">
            <span className="flex items-center gap-1.5">
              <Circle className="h-2 w-2 fill-primary text-primary" />
              Expires in{" "}
              <span className="font-mono font-bold text-foreground">{timeRemaining ?? "..."}</span>
            </span>
            <span>
              <span
                className={cn(
                  "font-mono font-bold",
                  remainingRequests <= 10 ? "text-destructive" : "text-foreground"
                )}
              >
                {remainingRequests}
              </span>{" "}
              requests left
            </span>
          </div>
        </div>

        {/* Registration push — appears once the first webhook lands */}
        {hasRequests && !upgradeDismissed ? (
          <div className="shrink-0 border-b-2 border-foreground bg-primary/10 px-4 py-2.5 flex items-center justify-between gap-4">
            <p className="text-sm font-medium">
              Webhook received! Create a free account to keep this endpoint — 50 requests/day, no
              credit card.
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <OAuthSignInButtons
                redirectTo="/dashboard"
                buttonClassName="h-8 text-xs px-3 w-auto"
                layout="horizontal"
              />
              <button
                onClick={() => setUpgradeDismissed(true)}
                className="p-1 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Dismiss sign-up banner"
              >
                <span className="text-lg leading-none">&times;</span>
              </button>
            </div>
          </div>
        ) : null}

        {/* Dashboard body — split pane like /dashboard */}
        <div className="flex-1 min-h-0">
          {hasRequests ? (
            <>
              <div className="hidden md:flex h-full overflow-hidden">
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
                    {displayDetail ? (
                      <RequestDetail request={displayDetail} />
                    ) : (
                      <RequestDetailEmpty />
                    )}
                  </ErrorBoundary>
                </div>
              </div>

              <div className="md:hidden h-full overflow-hidden flex flex-col">
                {mobileDetail && displayDetail ? (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    <button
                      onClick={() => setMobileDetail(false)}
                      className="border-b-2 border-foreground px-4 py-2 text-sm font-bold uppercase tracking-wide hover:bg-muted cursor-pointer transition-colors shrink-0"
                    >
                      &larr; Back to list
                    </button>
                    <div className="flex-1 overflow-hidden">
                      <ErrorBoundary resetKey={selectedId ?? undefined}>
                        <RequestDetail request={displayDetail} />
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
            <WaitingState
              url={endpointUrl}
              onSent={() => {
                if (endpointSlug) void refreshRequests(endpointSlug);
              }}
            />
          )}
        </div>

        {/* Frame footer */}
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-t-2 border-foreground px-4 py-2 bg-muted">
          <p className="text-xs text-muted-foreground font-bold">
            Guest endpoint &middot; no account needed &middot; {REQUEST_LIMIT} requests, 12 hours
          </p>
          <Link
            href="/go"
            onClick={() => trackCTAClick("try_live")}
            className="text-sm font-bold hover:text-primary transition-colors"
          >
            Open full-screen inspector
            <ArrowRight className="inline-block ml-1 h-4 w-4" />
          </Link>
        </div>
      </ErrorBoundary>
    </DashboardFrame>
  );
}

function UrlCopy({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (!(await copyToClipboard(url))) return;
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <code
        className="font-mono text-sm text-muted-foreground truncate cursor-pointer hover:text-foreground transition-colors"
        onClick={handleCopy}
        title="Click to copy"
        data-testid="instant-url"
      >
        {url}
      </code>
      <button
        onClick={handleCopy}
        className="p-1.5 hover:bg-muted transition-colors cursor-pointer border-2 border-foreground shrink-0"
        title="Copy URL"
        aria-label="Copy webhook URL"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function WaitingState({ url, onSent }: { url: string; onSent?: () => void }) {
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

  const curlCmd = `curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"hello": "world"}'`;

  const handleCopy = async () => {
    if (!(await copyToClipboard(curlCmd))) return;
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  const finishSend = useCallback(() => {
    setSent(true);
    if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
    sentTimeoutRef.current = setTimeout(() => setSent(false), SEND_FEEDBACK_MS);
    setSending(false);
    // Eagerly poll for the new request — don't wait for realtime
    setTimeout(() => onSent?.(), 150);
    setTimeout(() => onSent?.(), 500);
  }, [onSent]);

  const handleSendTest = useCallback(async () => {
    setSending(true);
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_TEST_SEND_HEADER]: "1",
        },
        body: JSON.stringify({
          message: "Hello from the browser!",
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {
      // CORS may block the response but the request still reaches the receiver
    } finally {
      finishSend();
    }
  }, [url, finishSend]);

  const handleSendProvider = useCallback(
    async (provider: "stripe" | "github" | "shopify") => {
      setSending(true);
      try {
        const template = await buildTemplateRequest({
          provider,
          secret: DEMO_PROVIDER_SECRET,
          targetUrl: url,
        });
        await fetch(url, {
          method: template.method,
          headers: {
            ...template.headers,
            [INTERNAL_TEST_SEND_HEADER]: "1",
          },
          body: template.body,
        });
      } catch {
        // CORS may block the response but the request still reaches the receiver
      } finally {
        finishSend();
      }
    },
    [url, finishSend]
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-full px-4 py-8 flex items-center justify-center">
        <div className="max-w-lg w-full text-center space-y-6">
          <div className="flex items-center justify-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping motion-reduce:animate-none absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-primary" />
            </span>
            <p className="font-bold uppercase tracking-wide">Waiting for first request...</p>
          </div>

          <button
            onClick={() => void handleSendTest()}
            disabled={sending}
            className="neo-btn-primary w-full py-4 text-lg flex items-center justify-center gap-2"
          >
            <Send className="h-5 w-5" />
            {sending ? "Sending..." : sent ? "Sent!" : "Send your first webhook"}
          </button>

          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Or try a signed provider payload
            </p>
            <div className="flex items-center justify-center gap-2">
              {(["Stripe", "GitHub", "Shopify"] as const).map((provider) => (
                <button
                  key={provider}
                  onClick={() =>
                    void handleSendProvider(
                      provider.toLowerCase() as "stripe" | "github" | "shopify"
                    )
                  }
                  disabled={sending}
                  className="neo-btn-outline text-sm py-2 px-4 cursor-pointer"
                >
                  {provider}
                </button>
              ))}
            </div>
          </div>

          <div className="text-left">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                Or use curl
              </span>
              <button
                onClick={() => void handleCopy()}
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
            <pre className="neo-code text-sm whitespace-pre-wrap break-all text-left">
              {curlCmd}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Full-bleed dashboard shell — fills the hero viewport like a real app screen.
 *  Top edge is provided by the title strip above it. */
function DashboardFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full border-b-2 border-foreground bg-background flex flex-col overflow-hidden">
      {children}
    </div>
  );
}
