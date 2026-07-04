"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { getWebhookUrl } from "@/lib/constants";
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
import {
  getMethodColor,
  formatRelativeTimestamp,
  formatBytes,
  type Request,
} from "@/types/request";
import { trackCTAClick, trackGuestEndpointCreated } from "@/lib/analytics";
import { ArrowRight, Check, Copy, X } from "lucide-react";

const REQUEST_LIMIT = 25;
const DEMO_ENDPOINT_STORAGE_KEY = "demo_endpoint";
// Local fallback so refreshes immediately after create still restore the slug.
const EXPIRY_MS = 12 * 60 * 60 * 1000;
const COPY_FEEDBACK_MS = 2000;
const SYNC_INTERVAL_MS = 2000;
const FEED_LIMIT = 6;

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

export function InstantUrlHero() {
  return (
    <SupabaseAuthProvider>
      <InstantUrlHeroInner />
    </SupabaseAuthProvider>
  );
}

function InstantUrlHeroInner() {
  const { isAuthenticated, isLoading } = useAuth();

  const [endpointSlug, setEndpointSlug] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<GuestEndpointRecord | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [copied, setCopied] = useState<"url" | "curl" | null>(null);
  const [upgradeDismissed, setUpgradeDismissed] = useState(false);

  const clearDemoEndpoint = useCallback((nextError: string | null = null) => {
    setEndpointSlug(null);
    setEndpoint(null);
    setRequests([]);
    setExpiresAt(null);
    setTimeRemaining(null);
    setCreateError(nextError);
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

  const handleCopy = useCallback(async (kind: "url" | "curl", text: string) => {
    if (await copyToClipboard(text)) {
      setCopied(kind);
      setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
    }
  }, []);

  const endpointUrl = endpointSlug ? getWebhookUrl(endpointSlug) : null;
  const requestCount = Math.max(endpoint?.requestCount ?? 0, requests.length);
  const remainingRequests = Math.max(0, REQUEST_LIMIT - requestCount);
  const curlCommand = endpointUrl
    ? `curl -X POST ${endpointUrl} -H "Content-Type: application/json" -d '{"event":"ping","ok":true}'`
    : null;

  // Signed-in visitors already have persistent endpoints — send them there.
  if (isAuthenticated) {
    return (
      <PanelShell>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 py-16 text-center">
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
      </PanelShell>
    );
  }

  if (createError) {
    return (
      <PanelShell>
        <div className="flex-1 flex flex-col items-center justify-center gap-4 py-16 text-center">
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
      </PanelShell>
    );
  }

  if (!endpointUrl) {
    return (
      <PanelShell>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 py-20 text-center">
          <span
            className="h-3 w-3 bg-primary border-2 border-foreground animate-pulse motion-reduce:animate-none"
            aria-hidden
          />
          <p className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
            Creating your webhook URL...
          </p>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      {/* Panel header — status strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-foreground bg-muted px-4 py-2">
        <p className="text-xs font-bold uppercase tracking-wide flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none"
            aria-hidden
          />
          Your webhook URL — live now
        </p>
        <p className="text-xs font-bold text-muted-foreground">
          {timeRemaining ? <>Expires in {timeRemaining} &middot; </> : null}
          {remainingRequests} of {REQUEST_LIMIT} requests left
        </p>
      </div>

      {/* URL row */}
      <div className="flex flex-col sm:flex-row gap-3 p-4">
        <code
          className="flex-1 font-mono text-sm md:text-base font-bold border-2 border-foreground bg-background px-3 py-3 overflow-x-auto whitespace-nowrap"
          data-testid="instant-url"
        >
          {endpointUrl}
        </code>
        <button
          onClick={() => void handleCopy("url", endpointUrl)}
          className="neo-btn-primary flex items-center justify-center gap-2 whitespace-nowrap"
          aria-label="Copy webhook URL"
        >
          {copied === "url" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied === "url" ? "Copied" : "Copy URL"}
        </button>
      </div>

      {/* Live feed */}
      <div className="border-t-2 border-foreground" aria-live="polite">
        {requests.length === 0 ? (
          <div className="px-4 py-8 text-center space-y-4">
            <p className="text-sm font-bold uppercase tracking-wide text-muted-foreground animate-pulse motion-reduce:animate-none">
              Waiting for your first request...
            </p>
            <p className="text-sm text-muted-foreground">
              Point any service at your URL — or try it right now from a terminal:
            </p>
            {curlCommand ? (
              <div className="neo-code text-left overflow-x-auto text-xs md:text-sm relative group">
                <pre className="pr-20">
                  <code>{curlCommand}</code>
                </pre>
                <button
                  onClick={() => void handleCopy("curl", curlCommand)}
                  className="absolute top-2 right-2 neo-btn-secondary text-xs py-1 px-2 flex items-center gap-1"
                  aria-label="Copy curl command"
                >
                  {copied === "curl" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied === "curl" ? "Copied" : "Copy"}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y-2 divide-foreground">
            {requests.slice(0, FEED_LIMIT).map((request) => (
              <li key={request._id}>
                <Link
                  href="/go"
                  onClick={() => trackCTAClick("try_live")}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted transition-colors"
                >
                  <span
                    className={cn(
                      "px-1.5 py-0.5 text-xs font-mono font-bold border-2 border-foreground shrink-0",
                      getMethodColor(request.method)
                    )}
                  >
                    {request.method}
                  </span>
                  <span className="font-mono text-sm truncate flex-1">{request.path}</span>
                  {request.detectedProvider ? (
                    <span className="hidden md:inline text-xs font-bold uppercase tracking-wide text-muted-foreground shrink-0">
                      {request.detectedProvider}
                      {request.detectedEvent ? ` · ${request.detectedEvent}` : ""}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatBytes(request.size)}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0 w-16 text-right">
                    {formatRelativeTimestamp(request.receivedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Registration push — appears once the first webhook lands */}
      {requestCount > 0 && !upgradeDismissed ? (
        <div className="border-t-2 border-foreground bg-primary/10 px-4 py-4 relative">
          <button
            onClick={() => setUpgradeDismissed(true)}
            className="absolute top-2 right-2 p-1 hover:bg-muted"
            aria-label="Dismiss sign-up banner"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-6">
            <div className="flex-1">
              <p className="font-bold">
                Captured. Don&apos;t lose this endpoint — this URL disappears in{" "}
                {timeRemaining ?? "12 hours"}.
              </p>
              <p className="text-sm text-muted-foreground">
                Sign up free to keep it: 50 requests/day, unlimited endpoints, CLI, SDK &amp; MCP.
                No credit card.
              </p>
            </div>
            <OAuthSignInButtons
              redirectTo="/dashboard"
              layout="horizontal"
              buttonClassName="h-10 text-sm px-4 neo-btn-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground cursor-pointer"
            />
          </div>
        </div>
      ) : null}

      {/* Panel footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-foreground px-4 py-2.5 bg-muted">
        <p className="text-xs text-muted-foreground font-bold">
          Guest endpoint &middot; no account needed &middot; {REQUEST_LIMIT} requests, 12 hours
        </p>
        <Link
          href="/go"
          onClick={() => trackCTAClick("try_live")}
          className="text-sm font-bold hover:text-primary transition-colors"
        >
          Open full inspector
          <ArrowRight className="inline-block ml-1 h-4 w-4" />
        </Link>
      </div>
    </PanelShell>
  );
}

/** Fixed-height shell so the hero doesn't shift while the endpoint loads. */
function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="neo-card neo-card-static p-0! overflow-hidden min-h-[320px] flex flex-col">
      {children}
    </div>
  );
}
