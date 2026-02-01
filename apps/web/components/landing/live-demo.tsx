"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";
import { Copy, Send, Plus, ChevronDown, ChevronRight } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { getMethodColor } from "@/types/request";
import { WEBHOOK_BASE_URL } from "@/lib/constants";

export function LiveDemo() {
  const [endpointSlug, setEndpointSlug] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendCount, setSendCount] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  const createEndpoint = useMutation(api.endpoints.create);

  // Check for existing ephemeral endpoint in localStorage
  useEffect(() => {
    const stored = localStorage.getItem("demo_endpoint");
    if (stored) {
      try {
        const { slug, expiresAt: storedExpiry } = JSON.parse(stored);
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
    try {
      const result = await createEndpoint({ isEphemeral: true });
      const expiry = Date.now() + 10 * 60 * 1000; // 10 minutes
      setEndpointSlug(result.slug);
      setExpiresAt(expiry);
      setSendCount(0);
      localStorage.setItem(
        "demo_endpoint",
        JSON.stringify({
          slug: result.slug,
          expiresAt: expiry,
        })
      );
    } finally {
      setIsCreating(false);
    }
  };

  const endpointUrl = endpointSlug ? `${WEBHOOK_BASE_URL}/w/${endpointSlug}` : null;

  const curlCommand = endpointUrl
    ? `curl -X POST ${endpointUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"hello": "world"}'`
    : null;

  const sendTestRequest = useCallback(async () => {
    if (!endpointUrl) return;
    setIsSending(true);
    try {
      const count = sendCount + 1;
      await fetch(endpointUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "Hello from the browser!",
          timestamp: new Date().toISOString(),
          requestNumber: count,
        }),
      });
      setSendCount(count);
    } catch {
      // Request may fail due to CORS, but the webhook will still be captured
    } finally {
      setIsSending(false);
    }
  }, [endpointUrl, sendCount]);

  const handleCopy = async (text: string, key: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  return (
    <div className="neo-card">
      {!endpointSlug ? (
        <div className="text-center py-12">
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
        </div>
      ) : (
        <div className="space-y-6">
          {/* Endpoint URL */}
          <div>
            <label className="text-sm font-bold uppercase tracking-wide mb-2 block">
              Your endpoint URL
            </label>
            <div className="flex gap-2">
              <div className="flex-1 neo-code py-3 font-mono text-sm overflow-x-auto">
                {endpointUrl}
              </div>
              <button
                onClick={() => endpointUrl && handleCopy(endpointUrl, "url")}
                className="neo-btn-outline py-2 px-4"
                aria-label={copied === "url" ? "Copied to clipboard" : "Copy URL to clipboard"}
              >
                {copied === "url" ? "Copied!" : <Copy className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {/* Send test request */}
          <div>
            <label className="text-sm font-bold uppercase tracking-wide mb-2 block">
              Send a test request
            </label>
            <div className="flex flex-wrap gap-3 mb-3">
              <button
                onClick={sendTestRequest}
                disabled={isSending}
                className="neo-btn-primary disabled:opacity-50"
              >
                <Send className="inline-block mr-2 h-4 w-4" />
                {isSending ? "Sending..." : "Send Test Request"}
              </button>
              <span className="text-sm text-muted-foreground self-center">or use curl:</span>
            </div>
            <div className="flex gap-2">
              <div className="flex-1 neo-code py-3 font-mono text-sm overflow-x-auto whitespace-pre">
                {curlCommand}
              </div>
              <button
                onClick={() => curlCommand && handleCopy(curlCommand, "curl")}
                className="neo-btn-outline py-2 px-4 self-start"
                aria-label={
                  copied === "curl" ? "Copied to clipboard" : "Copy curl command to clipboard"
                }
              >
                {copied === "curl" ? "Copied!" : <Copy className="h-5 w-5" />}
              </button>
            </div>
          </div>

          {/* Request list */}
          <div>
            <label className="text-sm font-bold uppercase tracking-wide mb-2 block">
              Incoming requests
            </label>
            <DemoRequestList slug={endpointSlug} />
          </div>

          {/* Expiry notice */}
          <div className="text-center pt-4 border-t-2 border-foreground">
            <p className="text-sm text-muted-foreground">
              {timeRemaining ? (
                <>
                  Expires in{" "}
                  <span className="font-mono font-bold text-foreground bg-secondary px-2 py-0.5">
                    {timeRemaining}
                  </span>
                </>
              ) : (
                "This endpoint expires in 10 minutes."
              )}{" "}
              <a
                href="/login"
                className="underline font-semibold text-foreground hover:text-primary"
              >
                Sign up
              </a>{" "}
              to keep your endpoints.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function DemoRequestList({ slug }: { slug: string }) {
  const endpoint = useQuery(api.endpoints.getBySlug, { slug });
  const requests = useQuery(
    api.requests.list,
    endpoint ? { endpointId: endpoint._id, limit: 10 } : "skip"
  );

  if (!endpoint) {
    return <div className="neo-code text-center py-8 text-muted-foreground">Loading...</div>;
  }

  if (!requests || requests.length === 0) {
    return (
      <div className="border-2 border-dashed border-foreground p-8 text-center text-muted-foreground">
        <p className="text-lg font-semibold mb-2">Waiting for requests...</p>
        <p className="text-sm">Send a request using the button above or curl command</p>
      </div>
    );
  }

  return <SimpleDemoList requests={requests} />;
}

function SimpleDemoList({
  requests,
}: {
  requests: Array<{
    _id: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: string;
    queryParams: Record<string, string>;
    contentType?: string;
    size: number;
    receivedAt: number;
  }>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="border-2 border-foreground divide-y-2 divide-foreground">
      {requests.map((request) => {
        const isExpanded = expandedId === request._id;
        const time = new Date(request.receivedAt).toLocaleTimeString();

        return (
          <div key={request._id}>
            <button
              onClick={() => setExpandedId(isExpanded ? null : request._id)}
              className="w-full p-4 flex items-center gap-4 hover:bg-muted/50 text-left cursor-pointer transition-colors"
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 flex-shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 flex-shrink-0" />
              )}
              <span
                className={cn(
                  "px-2 py-1 text-xs font-mono font-bold border-2 border-foreground",
                  getMethodColor(request.method)
                )}
              >
                {request.method}
              </span>
              <span className="font-mono text-sm flex-1 truncate">{request.path}</span>
              <span className="text-sm text-muted-foreground font-mono">{time}</span>
            </button>

            {isExpanded && (
              <div className="p-4 bg-muted border-t-2 border-foreground">
                <pre className="neo-code overflow-x-auto text-sm whitespace-pre-wrap">
                  {request.body
                    ? (() => {
                        try {
                          return JSON.stringify(JSON.parse(request.body), null, 2);
                        } catch {
                          return request.body;
                        }
                      })()
                    : "(empty body)"}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
