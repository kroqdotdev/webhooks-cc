"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";
import { Copy, Send, Plus, Check, Circle } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { Id } from "@convex/_generated/dataModel";
import { getMethodColor, formatRelativeTime, Request } from "@/types/request";
import { getWebhookUrl } from "@/lib/constants";

const REQUEST_LIMIT = 50;
const COPY_FEEDBACK_MS = 2000;
const SEND_FEEDBACK_MS = 3000;
const TABS = ["body", "headers", "query"] as const;
type Tab = (typeof TABS)[number];

export function LiveDemo() {
  const [endpointSlug, setEndpointSlug] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<Id<"requests"> | null>(null);

  const createEndpoint = useMutation(api.endpoints.create);

  // Query endpoint and requests
  const endpoint = useQuery(
    api.endpoints.getBySlug,
    endpointSlug ? { slug: endpointSlug } : "skip"
  );
  const requests = useQuery(
    api.requests.list,
    endpoint ? { endpointId: endpoint._id, limit: REQUEST_LIMIT } : "skip"
  );
  const requestCount = requests?.length ?? 0;
  const remainingRequests = REQUEST_LIMIT - requestCount;

  // Check for existing ephemeral endpoint in localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem("demo_endpoint");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        const slug = parsed?.slug;
        const storedExpiry = parsed?.expiresAt;
        if (typeof slug !== "string" || typeof storedExpiry !== "number") {
          localStorage.removeItem("demo_endpoint");
          return;
        }
        if (storedExpiry > Date.now()) {
          setEndpointSlug(slug);
          setExpiresAt(storedExpiry);
        } else {
          localStorage.removeItem("demo_endpoint");
        }
      } catch {
        localStorage.removeItem("demo_endpoint");
      }
    }
  }, []);

  // Auto-select first/newest request only if nothing is selected
  useEffect(() => {
    if (requests && requests.length > 0 && !selectedId) {
      setSelectedId(requests[0]._id);
    }
  }, [requests, selectedId]);

  // Countdown timer
  useEffect(() => {
    if (!expiresAt) {
      setTimeRemaining(null);
      return;
    }

    const updateTimer = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        setTimeRemaining(null);
        setEndpointSlug(null);
        setExpiresAt(null);
        setSelectedId(null);
        setError(null);
        localStorage.removeItem("demo_endpoint");
        return;
      }
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      setTimeRemaining(`${minutes}:${seconds.toString().padStart(2, "0")}`);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const handleCreateEndpoint = async () => {
    setIsCreating(true);
    setError(null);
    try {
      const result = await createEndpoint({ isEphemeral: true });
      const expiry = Date.now() + 10 * 60 * 1000;
      setEndpointSlug(result.slug);
      setExpiresAt(expiry);
      setSelectedId(null);
      localStorage.setItem(
        "demo_endpoint",
        JSON.stringify({
          slug: result.slug,
          expiresAt: expiry,
        })
      );
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      if (raw.includes("Rate limit exceeded") || raw.includes("Too many active demo endpoints")) {
        setError(raw);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setIsCreating(false);
    }
  };

  const endpointUrl = endpointSlug ? getWebhookUrl(endpointSlug) : null;
  const selectedRequest = requests?.find((r) => r._id === selectedId) ?? null;

  return (
    <div className="border-2 border-foreground bg-card overflow-hidden shadow-neo">
      {!endpointSlug ? (
        <div className="text-center py-12 px-6">
          <p className="text-xl text-muted-foreground mb-6">
            Create a temporary endpoint to see webhooks in action.
            <br />
            <span className="text-foreground font-semibold">No signup required.</span>
          </p>
          <button
            onClick={handleCreateEndpoint}
            disabled={isCreating}
            className="neo-btn-primary disabled:opacity-50"
          >
            <Plus className="inline-block mr-2 h-5 w-5" />
            {isCreating ? "Creating..." : "Create test endpoint"}
          </button>
          {error && (
            <p role="alert" className="text-sm text-destructive mt-4 font-medium">
              {error}
            </p>
          )}
          <p className="text-sm text-muted-foreground mt-4">
            Test endpoints support up to 50 requests and expire after 10 minutes.
          </p>
        </div>
      ) : (
        <div className="flex flex-col h-[500px]">
          {/* URL Bar */}
          <DemoUrlBar url={endpointUrl!} />

          {/* Split pane */}
          <div className="flex flex-1 overflow-hidden">
            {/* Request list */}
            <div className="w-72 shrink-0 border-r-2 border-foreground flex flex-col overflow-hidden">
              <DemoRequestList
                requests={requests}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </div>

            {/* Detail pane */}
            <div className="flex-1 overflow-hidden">
              {selectedRequest ? (
                <DemoRequestDetail request={selectedRequest} />
              ) : requests && requests.length > 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <p className="font-bold uppercase tracking-wide text-sm">
                    Select a request to view details
                  </p>
                </div>
              ) : (
                <DemoWaitingState url={endpointUrl!} />
              )}
            </div>
          </div>

          {/* Footer with limits */}
          <div className="border-t-2 border-foreground px-4 py-2 flex items-center justify-between bg-muted/30">
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Circle className="h-2 w-2 fill-primary text-primary" />
                {timeRemaining ? (
                  <span>
                    Expires in{" "}
                    <span className="font-mono font-bold text-foreground">{timeRemaining}</span>
                  </span>
                ) : (
                  "Expires in 10 minutes"
                )}
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
                requests remaining
              </span>
            </div>
            <a
              href="/login"
              className="text-xs font-bold uppercase tracking-wide px-3 py-1.5 border-2 border-foreground bg-secondary text-black hover:bg-secondary/80 transition-colors"
            >
              Sign up for more &rarr;
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function DemoUrlBar({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    const success = await copyToClipboard(url);
    if (success) {
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    }
  };

  return (
    <div className="border-b-2 border-foreground px-4 py-2 flex items-center gap-3">
      <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground shrink-0">
        Endpoint
      </span>
      <code className="font-mono text-sm flex-1 truncate">{url}</code>
      <button
        onClick={handleCopy}
        className="neo-btn-outline !py-1 !px-2 text-xs flex items-center gap-1"
        aria-label={copied ? "URL copied to clipboard" : "Copy endpoint URL"}
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
  );
}

function DemoRequestList({
  requests,
  selectedId,
  onSelect,
}: {
  requests: Request[] | undefined;
  selectedId: Id<"requests"> | null;
  onSelect: (id: Id<"requests">) => void;
}) {
  if (!requests) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <span className="text-xs font-bold uppercase tracking-wide">Loading...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="border-b-2 border-foreground px-3 py-2 flex items-center justify-between shrink-0">
        <span className="text-sm font-bold">
          {requests.length} request{requests.length !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-bold uppercase tracking-wide border-2 border-foreground bg-primary text-primary-foreground">
          <Circle className="h-2 w-2 fill-current" />
          Live
        </div>
      </div>

      {/* Request rows */}
      <div className="flex-1 overflow-y-auto">
        {requests.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground p-4">
            <span className="text-xs text-center">Waiting for requests...</span>
          </div>
        ) : (
          requests.map((request) => (
            <button
              key={request._id}
              onClick={() => onSelect(request._id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 text-left cursor-pointer transition-colors border-b border-foreground/10",
                selectedId === request._id
                  ? "bg-muted border-l-4 border-l-primary"
                  : "hover:bg-muted/50 border-l-4 border-l-transparent"
              )}
            >
              <span
                className={cn(
                  "px-1.5 py-0.5 text-[10px] font-mono font-bold border-2 border-foreground shrink-0 w-14 text-center",
                  getMethodColor(request.method)
                )}
              >
                {request.method}
              </span>
              <span className="text-xs text-muted-foreground font-mono truncate flex-1">
                #{request._id.slice(-6)}
              </span>
              <span className="text-xs text-muted-foreground font-mono shrink-0">
                {formatRelativeTime(request.receivedAt)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function DemoWaitingState({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
    };
  }, []);

  const curlCmd = `curl -X POST ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"hello": "world"}'`;

  const handleCopy = async () => {
    const success = await copyToClipboard(curlCmd);
    if (success) {
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    }
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
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
      sentTimeoutRef.current = setTimeout(() => setSent(false), SEND_FEEDBACK_MS);
    } catch (error) {
      // Request may fail due to CORS but still reaches server
      console.warn("Test request failed (may be CORS):", error);
      setSent(true);
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
      sentTimeoutRef.current = setTimeout(() => setSent(false), SEND_FEEDBACK_MS);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex items-center justify-center h-full p-6">
      <div className="max-w-sm w-full text-center space-y-5">
        <div className="flex items-center justify-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-primary" />
          </span>
          <p className="font-bold uppercase tracking-wide text-sm">Waiting for first request...</p>
        </div>

        <div className="text-left">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Send a test webhook
            </span>
            <button
              onClick={handleCopy}
              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer flex items-center gap-1 transition-colors"
              aria-label={copied ? "Command copied to clipboard" : "Copy curl command"}
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
          <pre className="neo-code text-xs whitespace-pre-wrap break-all text-left">{curlCmd}</pre>
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

function DemoRequestDetail({ request }: { request: Request }) {
  const [tab, setTab] = useState<Tab>("body");
  const [copied, setCopied] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async (text: string, key: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(key);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
    }
  };

  const formatBody = (body: string) => {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  };

  const fullTime = new Date(request.receivedAt).toLocaleTimeString();

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="border-b-2 border-foreground px-4 py-3 shrink-0">
        <div className="font-mono font-bold text-sm truncate">
          {request.method} {request.path}
        </div>
        <div className="text-xs text-muted-foreground font-mono mt-0.5">{fullTime}</div>
      </div>

      {/* Tabs */}
      <div className="border-b-2 border-foreground flex shrink-0" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            id={`tab-${t}`}
            role="tab"
            aria-selected={tab === t}
            aria-controls={`tabpanel-${t}`}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-xs font-bold uppercase tracking-wide border-r-2 border-foreground last:border-r-0 cursor-pointer transition-colors",
              tab === t ? "bg-foreground text-background" : "bg-background hover:bg-muted"
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div
        id={`tabpanel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="flex-1 overflow-auto p-4"
      >
        {tab === "body" && (
          <div className="relative">
            {request.body && (
              <button
                onClick={() => request.body && handleCopy(request.body, "body")}
                className="absolute top-2 right-2 neo-btn-outline !py-1 !px-2 text-xs flex items-center gap-1"
                aria-label={copied === "body" ? "Body copied to clipboard" : "Copy request body"}
              >
                {copied === "body" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
            )}
            <pre className="neo-code overflow-x-auto text-sm whitespace-pre-wrap break-words">
              {request.body ? formatBody(request.body) : "(empty body)"}
            </pre>
          </div>
        )}

        {tab === "headers" && (
          <div className="neo-code overflow-x-auto">
            <table className="text-sm font-mono w-full">
              <tbody>
                {Object.entries(request.headers).map(([key, value]) => (
                  <tr key={key} className="border-b border-foreground/20 last:border-0">
                    <td className="pr-4 py-1.5 text-muted-foreground font-semibold whitespace-nowrap align-top">
                      {key}
                    </td>
                    <td className="py-1.5 break-all">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "query" && (
          <div className="neo-code overflow-x-auto">
            {Object.keys(request.queryParams).length > 0 ? (
              <table className="text-sm font-mono w-full">
                <tbody>
                  {Object.entries(request.queryParams).map(([key, value]) => (
                    <tr key={key} className="border-b border-foreground/20 last:border-0">
                      <td className="pr-4 py-1.5 text-muted-foreground font-semibold whitespace-nowrap align-top">
                        {key}
                      </td>
                      <td className="py-1.5 break-all">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="text-muted-foreground">(no query params)</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
