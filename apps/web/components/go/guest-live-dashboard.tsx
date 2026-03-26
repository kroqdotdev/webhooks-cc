"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { getWebhookUrl } from "@/lib/constants";
import { ErrorBoundary } from "@/components/error-boundary";
import { ThemeToggle } from "@/components/ui/theme-toggle";
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
import { subscribeToEndpointRow, subscribeToEndpointRequestInserts } from "@/lib/supabase/realtime";
import type { Request, RequestSummary } from "@/types/request";
import { Check, Circle, Copy, Send } from "lucide-react";

const REQUEST_LIMIT = 25;
const BACKGROUND_SYNC_INTERVAL_MS = 2000;
const REQUEST_SYNC_INTERVAL_MS = 250;
const INTERNAL_TEST_SEND_HEADER = "X-Webhooks-CC-Test-Send";
// Local fallback so refreshes immediately after create still restore the slug.
// This is overwritten with the authoritative `endpoint.expiresAt` once the endpoint read completes.
const EXPIRY_MS = 12 * 60 * 60 * 1000;
const COPY_FEEDBACK_MS = 2000;
const SEND_FEEDBACK_MS = 3000;
const DEMO_ENDPOINT_STORAGE_KEY = "demo_endpoint";
const PROVIDER_PAYLOADS: Record<string, Record<string, unknown>> = {
  stripe: {
    id: "evt_1Example",
    type: "checkout.session.completed",
    data: {
      object: { id: "cs_test_123", amount_total: 4999, currency: "usd", status: "complete" },
    },
  },
  github: {
    action: "opened",
    pull_request: { number: 42, title: "Add webhook handler", user: { login: "octocat" } },
  },
  shopify: {
    topic: "orders/create",
    id: "820982911946154508",
    total_price: "59.99",
    currency: "USD",
    line_items: [{ title: "Widget", quantity: 2, price: "29.99" }],
  },
};

const RequestList = dynamic(
  () => import("@/components/dashboard/request-list").then((module) => module.RequestList),
  {
    ssr: false,
    loading: () => <RequestListLoading />,
  }
);
const RequestDetail = dynamic(
  () => import("@/components/dashboard/request-detail").then((module) => module.RequestDetail),
  {
    ssr: false,
    loading: () => <RequestDetailLoading />,
  }
);
const RequestDetailEmpty = dynamic(
  () => import("@/components/dashboard/request-detail").then((module) => module.RequestDetailEmpty),
  {
    ssr: false,
    loading: () => <RequestDetailLoading />,
  }
);

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

function RequestListLoading() {
  return (
    <div className="h-full flex items-center justify-center text-xs font-bold uppercase tracking-wide text-muted-foreground">
      Loading requests...
    </div>
  );
}

function RequestDetailLoading() {
  return (
    <div className="h-full flex items-center justify-center text-xs font-bold uppercase tracking-wide text-muted-foreground">
      Loading request...
    </div>
  );
}

export function GuestLiveDashboard() {
  return (
    <SupabaseAuthProvider>
      <GuestLiveDashboardInner />
    </SupabaseAuthProvider>
  );
}

function GuestLiveDashboardInner() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/dashboard");
    }
  }, [isAuthenticated, isLoading, router]);

  const [endpointSlug, setEndpointSlug] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<GuestEndpointRecord | null | undefined>(undefined);
  const [requests, setRequests] = useState<Request[]>([]);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [endpointLoadError, setEndpointLoadError] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [sortNewest, setSortNewest] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const prevRequestCount = useRef(0);
  const [upgradeDismissed, setUpgradeDismissed] = useState(false);

  // Debounce search to avoid unnecessary filtering work while typing
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
    setLiveMode(true);
    setSortNewest(true);
    setMobileDetail(false);
    setNewCount(0);
    setMethodFilter("ALL");
    setSearchInput("");
    setDebouncedSearch("");
    setCreateError(nextError);
    setEndpointLoadError(null);
    prevRequestCount.current = 0;
    if (typeof window !== "undefined") {
      localStorage.removeItem(DEMO_ENDPOINT_STORAGE_KEY);
    }
  }, []);

  const refreshEndpoint = useCallback(async (slug: string) => {
    try {
      const nextEndpoint = await fetchGuestDashboardEndpoint(slug);
      if (!nextEndpoint) {
        setEndpoint(null);
        setEndpointLoadError(
          "Could not restore your test endpoint yet. It may still be syncing, so try again."
        );
        return;
      }

      setEndpoint(nextEndpoint);
      setEndpointLoadError(null);

      if (typeof window !== "undefined" && nextEndpoint.expiresAt) {
        setExpiresAt(nextEndpoint.expiresAt);
        localStorage.setItem(
          DEMO_ENDPOINT_STORAGE_KEY,
          JSON.stringify({ slug: nextEndpoint.slug, expiresAt: nextEndpoint.expiresAt })
        );
      }
    } catch (error) {
      console.error("Failed to load guest endpoint:", error);
      setEndpointLoadError("Could not refresh your test endpoint. Please try again.");
    }
  }, []);

  const refreshRequests = useCallback(async (slug: string) => {
    try {
      const nextRequests = await fetchGuestDashboardRequests(slug, REQUEST_LIMIT);
      setRequests(nextRequests);
    } catch (error) {
      console.error("Failed to load guest requests:", error);
      setRequests([]);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const storedValue = localStorage.getItem(DEMO_ENDPOINT_STORAGE_KEY);
      const storedEndpoint = parseStoredDemoEndpoint(storedValue);

      if (!storedEndpoint) {
        if (storedValue) {
          localStorage.removeItem(DEMO_ENDPOINT_STORAGE_KEY);
        }
        return;
      }

      setEndpointSlug(storedEndpoint.slug);
      setExpiresAt(storedEndpoint.expiresAt);
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!endpointSlug) {
      setEndpoint(null);
      return;
    }

    setEndpoint(undefined);
    void refreshEndpoint(endpointSlug);
  }, [endpointSlug, refreshEndpoint]);

  useEffect(() => {
    if (!endpoint?.id || !endpointSlug) {
      setRequests([]);
      return;
    }

    void refreshRequests(endpointSlug);
  }, [endpoint?.id, endpointSlug, refreshRequests]);

  useEffect(() => {
    if (!expiresAt) {
      setTimeRemaining(null);
      return;
    }

    const updateTimer = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        localStorage.removeItem(DEMO_ENDPOINT_STORAGE_KEY);
        clearDemoEndpoint();
        return;
      }

      setTimeRemaining(formatRemainingTime(remaining));
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [clearDemoEndpoint, expiresAt]);

  useEffect(() => {
    if (!endpoint?.id || !endpointSlug) {
      return;
    }

    const unsubscribeEndpoint = subscribeToEndpointRow(endpoint.id, (row) => {
      if (!row) {
        clearDemoEndpoint("Your test endpoint expired. Create a new one.");
        return;
      }

      const nextEndpoint = normalizeGuestEndpoint(row);
      setEndpoint(nextEndpoint);
      setEndpointLoadError(null);

      if (typeof window !== "undefined" && nextEndpoint.expiresAt) {
        setExpiresAt(nextEndpoint.expiresAt);
        localStorage.setItem(
          DEMO_ENDPOINT_STORAGE_KEY,
          JSON.stringify({ slug: nextEndpoint.slug, expiresAt: nextEndpoint.expiresAt })
        );
      }

      void refreshRequests(endpointSlug);
    });

    // Subscribe to request INSERTs directly for faster updates
    const unsubscribeRequests = subscribeToEndpointRequestInserts(endpoint.id, () => {
      void refreshRequests(endpointSlug);
      void refreshEndpoint(endpointSlug);
    });

    return () => {
      unsubscribeEndpoint();
      unsubscribeRequests();
    };
  }, [clearDemoEndpoint, endpoint?.id, endpointSlug, refreshRequests, refreshEndpoint]);

  useEffect(() => {
    if (!endpoint?.id || !endpointSlug) {
      return;
    }

    if (endpoint.requestCount === 0 || requests.length >= endpoint.requestCount) {
      return;
    }

    void refreshRequests(endpointSlug);

    const interval = window.setInterval(() => {
      void refreshRequests(endpointSlug);
    }, REQUEST_SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [endpoint?.id, endpointSlug, endpoint?.requestCount, requests.length, refreshRequests]);

  useEffect(() => {
    if (!endpoint?.id || !endpointSlug) return;

    const onFocus = () => {
      void refreshEndpoint(endpointSlug);
      void refreshRequests(endpointSlug);
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
  }, [endpoint?.id, endpointSlug, refreshEndpoint, refreshRequests]);

  useEffect(() => {
    if (!endpoint?.id || !endpointSlug) {
      return;
    }

    const interval = window.setInterval(() => {
      // Browsers can deprioritize guest realtime delivery when the page is blurred.
      // Keep the guest dashboard fresh with a lightweight fallback sync until focus returns.
      if (document.visibilityState === "visible" && document.hasFocus()) {
        return;
      }

      void refreshEndpoint(endpointSlug);
      void refreshRequests(endpointSlug);
    }, BACKGROUND_SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [endpoint?.id, endpointSlug, refreshEndpoint, refreshRequests]);

  const filteredSummaries = useMemo(() => {
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      return requests
        .filter((r: Request) => {
          if (methodFilter !== "ALL" && r.method !== methodFilter) return false;
          const matchesPath = r.path.toLowerCase().includes(q);
          const matchesBody = r.body?.toLowerCase().includes(q) ?? false;
          const matchesId = r._id.toLowerCase().includes(q);
          return matchesPath || matchesBody || matchesId;
        })
        .map(
          (r): RequestSummary => ({
            _id: r._id,
            _creationTime: r._creationTime,
            method: r.method,
            path: r.path,
            contentType: r.contentType,
            size: r.size,
            receivedAt: r.receivedAt,
          })
        );
    }
    const filteredRequests =
      methodFilter === "ALL"
        ? requests
        : requests.filter((request) => request.method === methodFilter);
    return filteredRequests.map(
      (request): RequestSummary => ({
        _id: request._id,
        _creationTime: request._creationTime,
        method: request.method,
        path: request.path,
        contentType: request.contentType,
        size: request.size,
        receivedAt: request.receivedAt,
      })
    );
  }, [requests, methodFilter, debouncedSearch]);

  const displayDetail = useMemo(
    () => requests.find((request) => request._id === selectedId),
    [requests, selectedId]
  );

  const requestCount = Math.max(endpoint?.requestCount ?? 0, requests.length);
  const remainingRequests = Math.max(0, REQUEST_LIMIT - requestCount);

  useEffect(() => {
    if (requests.length === 0) {
      prevRequestCount.current = 0;
      return;
    }

    const currentCount = requests.length;
    const diff = currentCount - prevRequestCount.current;

    if (prevRequestCount.current > 0 && diff > 0) {
      if (liveMode) {
        setSelectedId(requests[0]?._id ?? null);
      } else {
        setNewCount((prev) => prev + diff);
      }
    }

    prevRequestCount.current = currentCount;
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

  const currentEndpointId = endpoint?.id;
  useEffect(() => {
    setSelectedId(null);
    setNewCount(0);
    prevRequestCount.current = 0;
    setMethodFilter("ALL");
    setSearchInput("");
    setDebouncedSearch("");
  }, [currentEndpointId]);

  const handleCreateEndpoint = useCallback(async () => {
    setIsCreating(true);
    setCreateError(null);
    setEndpointLoadError(null);

    try {
      const result = await createGuestDashboardEndpoint();
      const expiry = result.expiresAt ?? Date.now() + EXPIRY_MS;

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

  // Auto-create endpoint when visiting /go with no stored endpoint.
  // The ref gates this to a single attempt — handleCreateEndpoint is stable (useCallback, []).
  const autoCreateAttempted = useRef(false);
  useEffect(() => {
    if (!storageReady || endpointSlug || autoCreateAttempted.current) return;
    if (isAuthenticated) return;
    autoCreateAttempted.current = true;
    void handleCreateEndpoint();
  }, [storageReady, endpointSlug, isAuthenticated, handleCreateEndpoint]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMobileDetail(true);
  }, []);

  const handleToggleLiveMode = useCallback(() => {
    setLiveMode((prev) => !prev);
  }, []);

  const handleToggleSort = useCallback(() => {
    setSortNewest((prev) => !prev);
  }, []);

  const handleJumpToNew = useCallback(() => {
    if (requests.length === 0) return;
    setSelectedId(requests[0]!._id);
    setNewCount(0);
  }, [requests]);

  const handleDismissUpgrade = useCallback(() => setUpgradeDismissed(true), []);

  const handleRetryCreate = useCallback(() => {
    autoCreateAttempted.current = true; // keep true so the effect doesn't also fire
    setCreateError(null);
    void handleCreateEndpoint();
  }, [handleCreateEndpoint]);

  const endpointUrl = endpointSlug ? getWebhookUrl(endpointSlug) : null;

  if (!storageReady) {
    return (
      <div className="h-screen flex flex-col overflow-hidden">
        <GoHeader isAuthenticated={isAuthenticated} isLoading={true} />
        <div className="flex-1 flex items-center justify-center p-8">
          <p className="text-muted-foreground animate-pulse">Loading test endpoint...</p>
        </div>
      </div>
    );
  }

  if (!endpointSlug) {
    // Show error fallback with retry if auto-create failed
    if (createError) {
      return (
        <div className="h-screen flex flex-col overflow-hidden">
          <GoHeader isAuthenticated={isAuthenticated} isLoading={isLoading} />
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="neo-card neo-card-static max-w-md w-full text-center space-y-4">
              <div className="space-y-2">
                <h2 className="text-xl font-bold">Couldn&apos;t create your test endpoint</h2>
                <p className="text-sm text-muted-foreground">{createError}</p>
              </div>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={handleRetryCreate}
                  disabled={isCreating}
                  className="neo-btn-primary"
                >
                  {isCreating ? "Creating..." : "Try again"}
                </button>
                <Link href="/login" className="neo-btn-outline">
                  Sign in instead
                </Link>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Auto-create in progress — show loading state
    return (
      <div className="h-screen flex flex-col overflow-hidden">
        <GoHeader isAuthenticated={isAuthenticated} isLoading={isLoading} />
        <div className="flex-1 flex items-center justify-center p-8">
          <p className="text-muted-foreground animate-pulse">Creating test endpoint...</p>
        </div>
      </div>
    );
  }

  if (!endpointUrl || endpoint === undefined) {
    return (
      <div className="h-screen flex flex-col overflow-hidden">
        <GoHeader isAuthenticated={isAuthenticated} isLoading={isLoading} />
        <div className="flex-1 flex items-center justify-center p-8">
          {endpointLoadError ? (
            <div className="neo-card neo-card-static max-w-md w-full text-center space-y-4">
              <div className="space-y-2">
                <h2 className="text-xl font-bold">Couldn&apos;t load your test endpoint</h2>
                <p className="text-sm text-muted-foreground">{endpointLoadError}</p>
              </div>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => endpointSlug && void refreshEndpoint(endpointSlug)}
                  className="neo-btn-primary"
                >
                  Retry
                </button>
                <button onClick={() => clearDemoEndpoint()} className="neo-btn-outline">
                  Start over
                </button>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground animate-pulse">Loading test endpoint...</p>
          )}
        </div>
      </div>
    );
  }

  if (!endpoint) {
    return (
      <div className="h-screen flex flex-col overflow-hidden">
        <GoHeader isAuthenticated={isAuthenticated} isLoading={isLoading} />
        <div className="flex-1 flex items-center justify-center p-8">
          {endpointLoadError ? (
            <div className="neo-card neo-card-static max-w-md w-full text-center space-y-4">
              <div className="space-y-2">
                <h2 className="text-xl font-bold">Couldn&apos;t restore your test endpoint</h2>
                <p className="text-sm text-muted-foreground">{endpointLoadError}</p>
              </div>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => endpointSlug && void refreshEndpoint(endpointSlug)}
                  className="neo-btn-primary"
                >
                  Retry
                </button>
                <button onClick={() => clearDemoEndpoint()} className="neo-btn-outline">
                  Start over
                </button>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground animate-pulse">Loading test endpoint...</p>
          )}
        </div>
      </div>
    );
  }

  const hasRequests = requests.length > 0;
  const isSyncingRequests = requestCount > 0 && requests.length === 0;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <GoHeader isAuthenticated={isAuthenticated} isLoading={isLoading} />

      <ErrorBoundary resetKey={endpoint.id}>
        <DemoUrlBar
          url={endpointUrl}
          timeRemaining={timeRemaining}
          remainingRequests={remainingRequests}
        />

        {!upgradeDismissed && hasRequests && (
          <UpgradePrompt requestCount={requestCount} onDismiss={handleDismissUpgrade} />
        )}

        {hasRequests ? (
          <>
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
                  {displayDetail ? (
                    <RequestDetail request={displayDetail} />
                  ) : (
                    <RequestDetailEmpty />
                  )}
                </ErrorBoundary>
              </div>
            </div>

            <div className="md:hidden flex-1 overflow-hidden flex flex-col">
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
        ) : isSyncingRequests ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <p className="text-muted-foreground animate-pulse">Loading captured request...</p>
          </div>
        ) : (
          <DemoWaitingState
            url={endpointUrl}
            onSent={() => {
              if (endpointSlug) void refreshRequests(endpointSlug);
            }}
          />
        )}
      </ErrorBoundary>
    </div>
  );
}

function UpgradePrompt({
  requestCount,
  onDismiss,
}: {
  requestCount: number;
  onDismiss: () => void;
}) {
  const isUrgent = requestCount >= 20;
  const message = isUrgent
    ? `You've used ${requestCount} of 25 guest requests. Create a free account for 50/day.`
    : "Webhook received! Create a free account to keep your endpoints and get 50 requests/day.";

  return (
    <div
      className={cn(
        "shrink-0 border-b-2 border-foreground px-4 py-2.5 flex items-center justify-between gap-4",
        isUrgent ? "bg-destructive/15" : "bg-primary/10"
      )}
    >
      <p className="text-sm font-medium">{message}</p>
      <div className="flex items-center gap-2 shrink-0">
        <OAuthSignInButtons
          redirectTo="/dashboard"
          buttonClassName="h-8 text-xs px-3 w-auto"
          layout="horizontal"
        />
        <button
          onClick={onDismiss}
          className="p-1 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Dismiss"
        >
          <span className="text-lg leading-none">&times;</span>
        </button>
      </div>
    </div>
  );
}

function GoHeader({
  isAuthenticated,
  isLoading,
}: {
  isAuthenticated: boolean;
  isLoading: boolean;
}) {
  return (
    <header className="border-b-2 border-foreground shrink-0 bg-background sticky top-0 z-50">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/" className="font-bold text-lg">
          webhooks.cc
        </Link>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          {isLoading ? (
            <span className="neo-btn-outline text-sm py-2 px-4 w-28 text-center opacity-50">
              ...
            </span>
          ) : isAuthenticated ? (
            <Link href="/dashboard" className="neo-btn-primary text-sm py-2 px-4 w-28 text-center">
              Dashboard
            </Link>
          ) : (
            <Link href="/login" className="neo-btn-outline text-sm py-2 px-4 w-28 text-center">
              Sign In
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

function DemoUrlBar({
  url,
  timeRemaining,
  remainingRequests,
}: {
  url: string;
  timeRemaining: string | null;
  remainingRequests: number;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    const success = await copyToClipboard(url);
    if (!success) return;

    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  return (
    <div className="shrink-0">
      {/* URL bar -- compact single row matching dashboard style */}
      <div className="border-b-2 border-foreground bg-card px-4 py-2.5 flex items-center gap-3">
        <span className="font-bold text-sm uppercase tracking-wide shrink-0">Test Endpoint</span>

        <div className="flex items-center gap-1.5 min-w-0">
          <code
            className="font-mono text-sm text-muted-foreground truncate cursor-pointer hover:text-foreground transition-colors"
            onClick={handleCopy}
            title="Click to copy"
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

        <div className="hidden sm:flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
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

      {/* Mobile-only status row (visible below sm) */}
      <div className="sm:hidden border-b-2 border-foreground bg-card px-4 py-1.5 flex items-center gap-4 text-xs text-muted-foreground">
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
  );
}

function DemoWaitingState({ url, onSent }: { url: string; onSent?: () => void }) {
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
    const success = await copyToClipboard(curlCmd);
    if (!success) return;

    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  const sendPayload = useCallback(
    async (label: string, body: Record<string, unknown>) => {
      setSending(true);
      try {
        await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [INTERNAL_TEST_SEND_HEADER]: "1",
          },
          body: JSON.stringify(body),
        });
        setSent(true);
      } catch {
        // CORS may block the response but the request still reaches the receiver
        setSent(true);
      } finally {
        if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
        sentTimeoutRef.current = setTimeout(() => setSent(false), SEND_FEEDBACK_MS);
        setSending(false);
        // Eagerly poll for the new request — don't wait for realtime
        setTimeout(() => onSent?.(), 150);
        setTimeout(() => onSent?.(), 500);
      }
    },
    [url, onSent]
  );

  const handleSendTest = useCallback(
    () =>
      sendPayload("custom", {
        message: "Hello from the browser!",
        timestamp: new Date().toISOString(),
      }),
    [sendPayload]
  );

  const handleSendProvider = useCallback(
    (provider: string) => {
      void sendPayload(provider, PROVIDER_PAYLOADS[provider] ?? { provider, event: "test" });
    },
    [sendPayload]
  );

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

        <button
          onClick={handleSendTest}
          disabled={sending}
          className="neo-btn-primary w-full py-4 text-lg flex items-center justify-center gap-2"
        >
          <Send className="h-5 w-5" />
          {sending ? "Sending..." : sent ? "Sent!" : "Send your first webhook"}
        </button>

        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
            Or try a provider payload
          </p>
          <div className="flex items-center justify-center gap-2">
            {["Stripe", "GitHub", "Shopify"].map((provider) => (
              <button
                key={provider}
                onClick={() => handleSendProvider(provider.toLowerCase())}
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
      </div>
    </div>
  );
}
