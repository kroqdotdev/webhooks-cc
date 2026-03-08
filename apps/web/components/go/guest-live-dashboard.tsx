"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { getWebhookUrl } from "@/lib/constants";
import { ErrorBoundary } from "@/components/error-boundary";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import type { Id } from "@convex/_generated/dataModel";
import type { Request, RequestSummary } from "@/types/request";
import { ArrowRight, Bot, Check, Circle, Copy, Eye, Plus, Send, Terminal } from "lucide-react";
import { ConvexAuthProvider } from "@/components/providers/convex-auth-provider";

const REQUEST_LIMIT = 50;
// Local fallback so refreshes immediately after create still restore the slug.
// This is overwritten with the authoritative `endpoint.expiresAt` once Convex returns it.
const EXPIRY_MS = 12 * 60 * 60 * 1000;
const COPY_FEEDBACK_MS = 2000;
const SEND_FEEDBACK_MS = 3000;
const DEMO_ENDPOINT_STORAGE_KEY = "demo_endpoint";
const WEBHOOK_SITE_DIFF_ROWS = [
  ["Core webhook inspection", "Yes", "Yes"],
  ["CLI tunnel to localhost", "Yes", "Yes"],
  ["TypeScript SDK for automated tests", "Yes", "No first-party SDK"],
  ["MCP server for AI coding agents", "Yes", "No first-party server"],
  ["Pricing model", "Core features on every tier", "Feature-gated tiers"],
] as const;
const FREE_ACCOUNT_FEATURES = [
  "50 requests/day",
  "7-day data retention",
  "Unlimited endpoints",
  "CLI, SDK & MCP access",
] as const;
const GO_LANDING_FEATURES = [
  {
    title: "Inspect live payloads",
    description:
      "See method, headers, query params, and body in real time while your integration runs.",
    Icon: Eye,
  },
  {
    title: "Tunnel with the CLI",
    description:
      "Forward webhooks to localhost with `whk tunnel` so you can debug handlers on your local app.",
    Icon: Terminal,
  },
  {
    title: "Assert with the SDK",
    description:
      "Use the TypeScript SDK in test suites to wait for webhook events and assert payload shape.",
    Icon: Check,
  },
  {
    title: "Automate with MCP",
    description:
      "Let AI coding agents create endpoints, send tests, inspect requests, and replay events.",
    Icon: Bot,
  },
] as const;
const GO_VALUE_PILLS = [
  "No signup to start",
  "50 requests/day on free",
  "CLI, SDK, and MCP included",
] as const;

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
    <ConvexAuthProvider>
      <GuestLiveDashboardInner />
    </ConvexAuthProvider>
  );
}

function GuestLiveDashboardInner() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const createEndpoint = useMutation(api.endpoints.create);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/dashboard");
    }
  }, [isAuthenticated, isLoading, router]);

  const [endpointSlug, setEndpointSlug] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const [sortNewest, setSortNewest] = useState(true);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const prevRequestCount = useRef(0);

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

  const endpoint = useQuery(
    api.endpoints.getBySlug,
    endpointSlug ? { slug: endpointSlug } : "skip"
  );

  // Sync local expiry to the authoritative server expiry as soon as we have it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!endpointSlug || !endpoint?.isEphemeral || !endpoint.expiresAt) return;

    // Avoid unnecessary re-renders/LS writes.
    if (expiresAt === endpoint.expiresAt) return;

    setExpiresAt(endpoint.expiresAt);
    localStorage.setItem(
      DEMO_ENDPOINT_STORAGE_KEY,
      JSON.stringify({ slug: endpointSlug, expiresAt: endpoint.expiresAt })
    );
  }, [endpoint?.expiresAt, endpoint?.isEphemeral, endpointSlug, expiresAt]);

  const summaries = useQuery(
    api.requests.listSummaries,
    endpoint ? { endpointId: endpoint._id, limit: REQUEST_LIMIT } : "skip"
  );

  // Full list only needed when debounced search is active (body search)
  const needsFullList = debouncedSearch.length > 0;
  const fullRequests = useQuery(
    api.requests.list,
    needsFullList && endpoint ? { endpointId: endpoint._id, limit: REQUEST_LIMIT } : "skip"
  );

  // Full detail for selected request
  const selectedDetail = useQuery(
    api.requests.get,
    selectedId ? { id: selectedId as Id<"requests"> } : "skip"
  );

  const requestCount = endpoint?.requestCount ?? 0;
  const remainingRequests = Math.max(0, REQUEST_LIMIT - requestCount);

  // Cache last loaded request to prevent flicker during selection changes
  const lastLoadedDetail = useRef<typeof selectedDetail>(undefined);
  useEffect(() => {
    if (selectedDetail !== undefined) {
      lastLoadedDetail.current = selectedDetail;
    }
  }, [selectedDetail]);

  // Clear stale selectedId when the request no longer exists
  useEffect(() => {
    if (selectedDetail === null && selectedId) {
      setSelectedId(null);
    }
  }, [selectedDetail, selectedId]);

  // Show previous request while new one loads (prevents flicker)
  const displayDetail = selectedDetail !== undefined ? selectedDetail : lastLoadedDetail.current;

  const clearDemoEndpoint = useCallback((nextError: string | null = null) => {
    setEndpointSlug(null);
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
    prevRequestCount.current = 0;
    if (typeof window !== "undefined") {
      localStorage.removeItem(DEMO_ENDPOINT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const stored = localStorage.getItem(DEMO_ENDPOINT_STORAGE_KEY);
    if (!stored) return;

    try {
      const parsed = JSON.parse(stored);
      const slug = parsed?.slug;
      const storedExpiry = parsed?.expiresAt;

      if (typeof slug !== "string" || typeof storedExpiry !== "number") {
        localStorage.removeItem(DEMO_ENDPOINT_STORAGE_KEY);
        return;
      }

      if (storedExpiry <= Date.now()) {
        localStorage.removeItem(DEMO_ENDPOINT_STORAGE_KEY);
        return;
      }

      setEndpointSlug(slug);
      setExpiresAt(storedExpiry);
    } catch {
      localStorage.removeItem(DEMO_ENDPOINT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!expiresAt) {
      setTimeRemaining(null);
      return;
    }

    const updateTimer = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
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
    if (!endpointSlug || endpoint !== null) return;

    clearDemoEndpoint("Your test endpoint expired. Create a new one.");
  }, [clearDemoEndpoint, endpoint, endpointSlug]);

  const filteredSummaries = useMemo(() => {
    if (debouncedSearch && fullRequests) {
      const q = debouncedSearch.toLowerCase();
      return fullRequests
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
            receivedAt: r.receivedAt,
          })
        );
    }
    if (!summaries) return [];
    if (methodFilter === "ALL") return summaries;
    return summaries.filter((r) => r.method === methodFilter);
  }, [summaries, fullRequests, methodFilter, debouncedSearch]);

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

  useEffect(() => {
    if (summaries && summaries.length > 0 && !selectedId) {
      setSelectedId(summaries[0]._id);
    }
  }, [summaries, selectedId]);

  const currentEndpointId = endpoint?._id;
  useEffect(() => {
    setSelectedId(null);
    setNewCount(0);
    prevRequestCount.current = 0;
    setMethodFilter("ALL");
    setSearchInput("");
    setDebouncedSearch("");
    lastLoadedDetail.current = undefined;
  }, [currentEndpointId]);

  const handleCreateEndpoint = async () => {
    setIsCreating(true);
    setCreateError(null);

    try {
      const result = await createEndpoint({ isEphemeral: true });
      const expiry = Date.now() + EXPIRY_MS;

      setEndpointSlug(result.slug);
      setExpiresAt(expiry);
      setSelectedId(null);

      localStorage.setItem(
        DEMO_ENDPOINT_STORAGE_KEY,
        JSON.stringify({ slug: result.slug, expiresAt: expiry })
      );
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "";
      if (
        rawMessage.includes("Rate limit exceeded") ||
        rawMessage.includes("Too many active demo endpoints")
      ) {
        setCreateError(rawMessage);
      } else {
        setCreateError("Something went wrong. Please try again.");
      }
    } finally {
      setIsCreating(false);
    }
  };

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
    if (!summaries || summaries.length === 0) return;
    setSelectedId(summaries[0]._id);
    setNewCount(0);
  }, [summaries]);

  const endpointUrl = endpointSlug ? getWebhookUrl(endpointSlug) : null;

  if (!endpointSlug) {
    return (
      <div className="h-screen flex flex-col overflow-hidden">
        <GoHeader isAuthenticated={isAuthenticated} isLoading={isLoading} />
        <GoPreCreateLanding
          isCreating={isCreating}
          createError={createError}
          onCreateEndpoint={handleCreateEndpoint}
        />
      </div>
    );
  }

  if (!endpointUrl || !endpoint) {
    return (
      <div className="h-screen flex flex-col overflow-hidden">
        <GoHeader isAuthenticated={isAuthenticated} isLoading={isLoading} />
        <div className="flex-1 flex items-center justify-center p-8">
          <p className="text-muted-foreground animate-pulse">Loading test endpoint...</p>
        </div>
      </div>
    );
  }

  const hasRequests = Boolean(summaries && summaries.length > 0);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <GoHeader isAuthenticated={isAuthenticated} isLoading={isLoading} />

      <ErrorBoundary resetKey={endpoint._id}>
        <DemoUrlBar
          url={endpointUrl}
          timeRemaining={timeRemaining}
          remainingRequests={remainingRequests}
        />

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
        ) : (
          <DemoWaitingState url={endpointUrl} />
        )}
      </ErrorBoundary>
    </div>
  );
}

function GoPreCreateLanding({
  isCreating,
  createError,
  onCreateEndpoint,
}: {
  isCreating: boolean;
  createError: string | null;
  onCreateEndpoint: () => Promise<void>;
}) {
  return (
    <div className="flex-1 overflow-auto">
      <section className="px-4 pt-8 md:pt-12 pb-8 md:pb-10">
        <div className="max-w-7xl mx-auto grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.95fr)]">
          <div className="neo-card neo-card-static space-y-6">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Webhook testing workspace
            </p>
            <h1 className="text-3xl md:text-5xl font-bold leading-tight max-w-4xl">
              Test webhooks live, then scale with CLI, SDK, and MCP
            </h1>
            <p className="text-base md:text-lg text-muted-foreground leading-relaxed max-w-2xl">
              Create a temporary endpoint in one click and inspect real webhook payloads instantly.
              When you are ready, move to a free account for permanent endpoints and full developer
              tooling.
            </p>
            <div className="flex flex-wrap gap-2">
              {GO_VALUE_PILLS.map((pill) => (
                <span
                  key={pill}
                  className="border-2 border-foreground/60 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide bg-muted"
                >
                  {pill}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={onCreateEndpoint}
                disabled={isCreating}
                className="neo-btn-primary disabled:opacity-50 min-w-52"
              >
                <Plus className="inline-block mr-2 h-4 w-4" />
                {isCreating ? "Creating..." : "Create test endpoint"}
              </button>
              <Link href="/login" className="neo-btn-outline">
                Create free account
              </Link>
            </div>
            {createError && (
              <p role="alert" className="text-sm text-destructive font-medium">
                {createError}
              </p>
            )}
            <p className="text-sm text-muted-foreground leading-relaxed">
              Guest endpoints support up to 25 requests and expire after 12 hours.
            </p>
          </div>

          <aside className="neo-card space-y-5">
            <div className="space-y-1.5">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                Pricing snapshot
              </p>
              <h2 className="text-2xl font-bold leading-tight">Free account includes</h2>
            </div>
            <ul className="space-y-2.5">
              {FREE_ACCOUNT_FEATURES.map((feature) => (
                <li key={feature} className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-primary flex-shrink-0" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Start on free with no credit card. Pro is $8/month for 100,000 requests/month and
              30-day retention.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/compare/webhook-site" className="neo-btn-outline text-sm py-2 px-3">
                Compare vs Webhook.site
              </Link>
              <Link href="/docs/cli" className="neo-btn-outline text-sm py-2 px-3">
                CLI docs
              </Link>
            </div>
          </aside>
        </div>
      </section>

      <section className="px-4 pb-10">
        <div className="max-w-7xl mx-auto space-y-5">
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Workflow coverage
            </p>
            <h2 className="text-2xl md:text-3xl font-bold">One platform for manual tests and automation</h2>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {GO_LANDING_FEATURES.map((feature) => {
              const Icon = feature.Icon;
              return (
                <article key={feature.title} className="neo-card neo-card-static">
                  <div className="w-10 h-10 border-2 border-foreground bg-muted flex items-center justify-center mb-3">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="font-bold text-lg mb-2">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">{feature.description}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="px-4 pb-16">
        <div className="max-w-7xl mx-auto neo-card neo-card-static space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1.5">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                Comparison
              </p>
              <h2 className="text-2xl md:text-3xl font-bold">webhooks.cc vs Webhook.site</h2>
              <p className="text-muted-foreground">
                Compare request inspection, price model, and workflow support for CLI, SDK, and MCP.
              </p>
            </div>
            <Link href="/compare/webhook-site" className="neo-btn-outline text-sm py-2 px-3">
              Read full comparison <ArrowRight className="inline h-4 w-4 ml-1" />
            </Link>
          </div>

          <div className="neo-code overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-foreground">
                  <th scope="col" className="text-left py-2 pr-3">
                    Category
                  </th>
                  <th scope="col" className="text-left py-2 pr-3">
                    webhooks.cc
                  </th>
                  <th scope="col" className="text-left py-2">
                    Webhook.site
                  </th>
                </tr>
              </thead>
              <tbody>
                {WEBHOOK_SITE_DIFF_ROWS.map(([label, left, right]) => (
                  <tr key={label} className="border-b border-foreground/20 last:border-0">
                    <td className="py-2 pr-3 font-semibold">{label}</td>
                    <td className="py-2 pr-3">{left}</td>
                    <td className="py-2">{right}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link href="/docs/sdk" className="neo-btn-outline text-sm py-2 px-3">
              SDK docs
            </Link>
            <Link href="/docs/mcp" className="neo-btn-outline text-sm py-2 px-3">
              MCP docs
            </Link>
            <Link href="/" className="neo-btn-outline text-sm py-2 px-3">
              Pricing overview
            </Link>
          </div>
        </div>
      </section>
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

      {/* Sign-up banner */}
      <div className="border-b-2 border-foreground bg-amber-500/25 px-4 py-1.5 flex items-center justify-between gap-4">
        <span className="text-xs text-muted-foreground">
          <span className="hidden md:inline">
            Guest: <strong className="text-foreground">25 requests</strong>, temporary endpoint.
            Free account: <strong className="text-foreground">50 requests/day</strong>, permanent
            endpoints, CLI + SDK.
          </span>
          <span className="md:hidden">
            Free: <strong className="text-foreground">50 requests/day</strong>, permanent endpoints
          </span>
        </span>
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden md:inline text-xs text-muted-foreground">
            Register free, <strong className="text-foreground">no credit card</strong>
          </span>
          <OAuthSignInButtons
            redirectTo="/dashboard"
            buttonClassName="h-7 text-xs px-3 w-auto"
            layout="horizontal"
          />
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

function DemoWaitingState({ url }: { url: string }) {
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

  const handleSendTest = async () => {
    setSending(true);

    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Hello from the browser!",
          timestamp: new Date().toISOString(),
        }),
      });
      setSent(true);
    } catch {
      // Request can fail due to CORS while still reaching the webhook receiver.
      setSent(true);
    } finally {
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
      sentTimeoutRef.current = setTimeout(() => setSent(false), SEND_FEEDBACK_MS);
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
