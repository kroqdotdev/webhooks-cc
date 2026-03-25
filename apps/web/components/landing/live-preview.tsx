"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Send, ArrowRight } from "lucide-react";
import { OAuthSignInButtons } from "@/components/auth/oauth-signin-buttons";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";

const MOCK_SLUG = "abc123";
const MOCK_URL = `https://go.webhooks.cc/w/${MOCK_SLUG}`;

interface MockRequest {
  id: string;
  method: string;
  path: string;
  timestamp: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const MOCK_REQUESTS: MockRequest[] = [
  {
    id: "req_3",
    method: "POST",
    path: "/webhooks/stripe",
    timestamp: "just now",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1711929600,v1=5257a869...",
    },
    body: {
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_123", amount_total: 4999, currency: "usd" } },
    },
  },
  {
    id: "req_2",
    method: "POST",
    path: "/webhooks/stripe",
    timestamp: "2s ago",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1711929598,v1=8f3c2a01...",
    },
    body: {
      type: "invoice.payment_succeeded",
      data: { object: { id: "in_test_456", amount_paid: 800, currency: "usd" } },
    },
  },
  {
    id: "req_1",
    method: "POST",
    path: "/webhooks/stripe",
    timestamp: "5s ago",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1711929595,v1=a2b1c3d4...",
    },
    body: {
      type: "customer.subscription.created",
      data: { object: { id: "sub_test_789", status: "active", plan: { amount: 800 } } },
    },
  },
];

export function LivePreview() {
  return (
    <SupabaseAuthProvider>
      <LivePreviewInner />
    </SupabaseAuthProvider>
  );
}

function LivePreviewInner() {
  const { isAuthenticated } = useAuth();
  const [requests, setRequests] = useState<MockRequest[]>([]);
  const [selected, setSelected] = useState<MockRequest | null>(null);
  const [sending, setSending] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const nextIndex = useRef(0);
  const sendingRef = useRef(false);
  const handleDismissOverlay = useCallback(() => setShowOverlay(false), []);

  const handleSend = useCallback(() => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);

    setTimeout(() => {
      const req = MOCK_REQUESTS[nextIndex.current % MOCK_REQUESTS.length]!;
      const newReq = { ...req, id: `req_${Date.now()}`, timestamp: "just now" };
      setRequests((prev) => [newReq, ...prev].slice(0, 5));
      setSelected(newReq);
      nextIndex.current++;
      sendingRef.current = false;
      setSending(false);

      if (nextIndex.current >= 2 && !isAuthenticated) {
        setShowOverlay(true);
      }
    }, 300);
  }, [isAuthenticated]);

  return (
    <div className="mt-10 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
          Live preview
        </p>
        <button
          onClick={handleSend}
          disabled={sending}
          className="neo-btn-primary text-sm py-2 px-4 flex items-center gap-2 cursor-pointer"
        >
          <Send className="h-3.5 w-3.5" />
          {sending ? "Sending..." : "Send a webhook"}
        </button>
      </div>

      <div className="neo-card neo-card-static p-0! overflow-hidden relative">
        {/* URL bar */}
        <div className="bg-card px-4 py-2 border-b-2 border-foreground flex items-center gap-3">
          <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground shrink-0">
            Endpoint
          </span>
          <code className="text-xs font-mono text-muted-foreground truncate">{MOCK_URL}</code>
        </div>

        {/* Dashboard split pane */}
        <div className="flex min-h-[280px]">
          {/* Request list */}
          <div className="w-48 md:w-56 shrink-0 border-r-2 border-foreground overflow-hidden">
            {requests.length === 0 ? (
              <div className="flex items-center justify-center h-full p-4">
                <p className="text-xs text-muted-foreground text-center">
                  Click &ldquo;Send a webhook&rdquo; to see it appear here
                  <ArrowRight className="inline-block ml-1 h-3 w-3" />
                </p>
              </div>
            ) : (
              <div className="divide-y-2 divide-foreground/10">
                {requests.map((req) => (
                  <button
                    key={req.id}
                    onClick={() => setSelected(req)}
                    className={`w-full text-left px-3 py-2.5 text-xs cursor-pointer transition-colors ${
                      selected?.id === req.id ? "bg-primary/10" : "hover:bg-muted"
                    }`}
                  >
                    <span className="font-mono font-bold text-primary">{req.method}</span>
                    <span className="text-muted-foreground ml-2">{req.path}</span>
                    <span className="block text-muted-foreground/60 mt-0.5">{req.timestamp}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Detail pane */}
          <div className="flex-1 overflow-auto">
            {selected ? (
              <div className="p-4 text-xs space-y-3">
                <div>
                  <p className="font-bold uppercase tracking-wide text-muted-foreground mb-1">
                    Headers
                  </p>
                  <div className="neo-code p-2! shadow-none! text-xs">
                    {Object.entries(selected.headers).map(([k, v]) => (
                      <div key={k}>
                        <span className="text-muted-foreground">{k}:</span>{" "}
                        <span className="text-foreground">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="font-bold uppercase tracking-wide text-muted-foreground mb-1">
                    Body
                  </p>
                  <pre className="neo-code p-2! shadow-none! text-xs whitespace-pre-wrap">
                    {JSON.stringify(selected.body, null, 2)}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full p-4">
                <p className="text-xs text-muted-foreground">Select a request to inspect</p>
              </div>
            )}
          </div>
        </div>

        {/* Signup overlay — appears after 2nd send for unauthenticated users */}
        {showOverlay && (
          <div className="absolute inset-0 bg-background/90 backdrop-blur-sm flex items-center justify-center z-10">
            <div className="text-center space-y-4 max-w-sm px-6">
              <p className="font-bold text-lg">Try it with real webhooks</p>
              <p className="text-sm text-muted-foreground">
                Create a free account and send actual Stripe, GitHub, and Shopify webhooks to your
                own endpoint.
              </p>
              <div className="flex justify-center">
                <OAuthSignInButtons
                  redirectTo="/dashboard"
                  layout="horizontal"
                  buttonClassName="h-10 text-sm px-4 neo-btn-outline cursor-pointer"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                or{" "}
                <Link
                  href="/go"
                  className="text-foreground font-bold hover:text-primary transition-colors"
                >
                  try without an account
                  <ArrowRight className="inline-block ml-1 h-3.5 w-3.5" />
                </Link>
              </p>
              <button
                onClick={handleDismissOverlay}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
