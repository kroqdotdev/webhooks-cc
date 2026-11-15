"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SiteHeader } from "@/components/nav/site-header";
import { SupabaseAuthProvider, useAuth } from "@/components/providers/supabase-auth-provider";
import { MfaGate } from "@/components/auth/mfa-challenge";
import { CheckoutReview, type CheckoutReviewData } from "@/components/billing/checkout-review";
import { supersededExplanation } from "@/lib/billing/superseded-copy";
import {
  refusalPhase,
  runOpen,
  type ApiAnswer,
  type OpenAnswer,
} from "@/lib/billing/checkout-page-flow";
import { createClient } from "@/lib/supabase/client";

// A checkout link's page (lib/billing/checkout-links.ts): an agent or tool
// made a link for something the account can buy, and the person opens it
// here, signed in as the account's owner. The page first shows what it buys
// and costs, the account that pays, who asked, when and from where, and
// makes nothing: a link that opens a payment on one click is what a phisher
// would send. Only "Continue to payment" has the server check the purchase
// again and make Polar's checkout, and then this page sends them on to it.
// A reopen goes back to the same checkout while it is still open.

export default function CheckoutLinkPage() {
  return (
    <SupabaseAuthProvider>
      <MfaGate>
        <CheckoutLinkContent />
      </MfaGate>
    </SupabaseAuthProvider>
  );
}

type Phase =
  | { kind: "loading" }
  | { kind: "review"; review: CheckoutReviewData; opening: boolean }
  | { kind: "redirect"; summary: string }
  | { kind: "paid"; summary: string }
  | { kind: "processing"; summary: string }
  | { kind: "expired"; summary: string }
  | { kind: "superseded"; summary: string; explanation: string }
  | { kind: "wrong_account"; message: string }
  | { kind: "gone"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string; retry: "review" | "open" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The phase for a refusal from either route (refusalPhase()). */
function refusal(
  response: Response,
  result: ApiAnswer,
  fallback: string,
  retry: "review" | "open"
): Phase {
  return refusalPhase(response.status, result, fallback, retry);
}

function CheckoutLinkContent() {
  const { isAuthenticated, isLoading, session } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" && UUID.test(params.id) ? params.id : null;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const loaded = useRef(false);
  // False once the person has left the page (a client navigation from the
  // header): a pending open then neither redirects nor asks again.
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      const here = id ? `/checkout/${id}` : "/checkout";
      router.push(`/login?redirect=${encodeURIComponent(here)}`);
    }
  }, [isAuthenticated, isLoading, router, id]);

  // Reads the link without making anything: what the person decides on.
  const load = useCallback(async (linkId: string, token: string) => {
    setPhase({ kind: "loading" });
    const failed = "This checkout link could not be read. Try again.";
    try {
      const response = await fetch(`/api/billing/checkouts/${linkId}/review`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = (await response.json()) as ApiAnswer & { review?: CheckoutReviewData };
      if (!response.ok || !result.review) {
        setPhase(refusal(response, result, failed, "review"));
        return;
      }
      const review = result.review;
      // The purchase check ran with the review: say so before anything else.
      if (review.status === "open" && review.unavailable) {
        setPhase({ kind: "refused", message: review.unavailable });
      } else if (review.status === "open") setPhase({ kind: "review", review, opening: false });
      else if (review.status === "superseded") {
        setPhase({
          kind: "superseded",
          summary: review.summary,
          explanation: supersededExplanation(review.kind, review.resource),
        });
      } else setPhase({ kind: review.status, summary: review.summary });
    } catch {
      setPhase({ kind: "failed", message: failed, retry: "review" });
    }
  }, []);

  // The person chose to pay: only now is Polar's checkout made.
  const open = useCallback(async (linkId: string, token: string, review?: CheckoutReviewData) => {
    if (review) setPhase({ kind: "review", review, opening: true });
    else setPhase({ kind: "loading" });
    const failed = "This checkout could not be opened. Try again.";
    try {
      const outcome = await runOpen({
        request: async () => {
          const response = await fetch(`/api/billing/checkouts/${linkId}/open`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
          const answer = (await response.json()) as OpenAnswer;
          return { ok: response.ok, status: response.status, answer };
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        active: () => active.current,
        failed,
      });
      if (outcome === null) return;
      if (outcome.kind === "redirect") {
        setPhase({ kind: "redirect", summary: outcome.summary });
        window.location.assign(outcome.url);
        return;
      }
      if (outcome.kind === "refusal") {
        setPhase(outcome.phase);
        return;
      }
      if (outcome.kind === "failed") {
        setPhase({ kind: "failed", message: failed, retry: "open" });
        return;
      }
      const result = outcome.answer;
      const summary = result.summary ?? "";
      const kind = result.status;
      if (kind === "superseded") {
        setPhase({
          kind,
          summary,
          // The answer's own kind and resource: a retried open has no review.
          explanation: supersededExplanation(
            result.kind ?? review?.kind,
            result.kind ? result.resource : review?.resource
          ),
        });
      } else if (kind === "paid" || kind === "processing" || kind === "expired") {
        setPhase({ kind, summary });
      } else {
        setPhase({ kind: "failed", message: failed, retry: "open" });
      }
    } catch {
      if (active.current) setPhase({ kind: "failed", message: failed, retry: "open" });
    }
  }, []);

  useEffect(() => {
    const token = session?.access_token;
    if (!isAuthenticated || !token || loaded.current) return;
    loaded.current = true;
    if (!id) {
      setPhase({ kind: "gone", message: "This checkout link does not exist." });
      return;
    }
    void load(id, token);
  }, [isAuthenticated, session?.access_token, id, load]);

  const switchAccount = async () => {
    await createClient().auth.signOut();
    router.push(`/login?redirect=${encodeURIComponent(`/checkout/${id ?? ""}`)}`);
  };

  if (isLoading || !isAuthenticated) return <Loading />;

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />
      <main className="flex-1 flex items-center justify-center px-4 pt-10 pb-12">
        <div className="w-full max-w-md" data-testid="checkout-link">
          {phase.kind === "loading" && <Loading inline />}

          {phase.kind === "review" && (
            <CheckoutReview
              review={phase.review}
              opening={phase.opening}
              onContinue={() => {
                const token = session?.access_token;
                if (id && token) void open(id, token, phase.review);
              }}
            />
          )}

          {phase.kind === "redirect" && (
            <Notice title="Opening the checkout" summary={phase.summary}>
              Taking you to Polar, who handles payments for webhooks.cc. Nothing is charged until
              you pay there.
            </Notice>
          )}

          {phase.kind === "paid" && (
            <Notice title="Already paid" summary={phase.summary}>
              This was paid, and it is on the account. You can close this page.
            </Notice>
          )}

          {phase.kind === "processing" && (
            <Notice title="Payment in progress" summary={phase.summary}>
              Polar is processing the payment. It is applied to the account within a minute of going
              through.
            </Notice>
          )}

          {phase.kind === "expired" && (
            <Notice title="This link has expired" summary={phase.summary}>
              Nothing was charged. If you still want it, ask the agent or tool for a new link.
            </Notice>
          )}

          {phase.kind === "superseded" && (
            <Notice title="Undone as a duplicate" summary={phase.summary}>
              {phase.explanation}
            </Notice>
          )}

          {phase.kind === "wrong_account" && (
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-3">Not this account</h1>
              <p className="text-muted-foreground mb-6">{phase.message}</p>
              <Button
                variant="surface"
                className="w-full h-11"
                onClick={() => void switchAccount()}
              >
                Sign in with another account
              </Button>
            </div>
          )}

          {(phase.kind === "gone" || phase.kind === "refused") && (
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-3">
                {phase.kind === "gone" ? "Link not found" : "This cannot be bought now"}
              </h1>
              <p className="text-muted-foreground mb-6">{phase.message}</p>
              <Button
                variant="surface"
                className="w-full h-11"
                render={<Link href="/account/plan" />}
              >
                Open Plan
              </Button>
            </div>
          )}

          {phase.kind === "failed" && (
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-3">
                {phase.retry === "open" ? "The checkout did not open" : "Something went wrong"}
              </h1>
              <p className="text-muted-foreground mb-6">{phase.message}</p>
              <Button
                className="w-full h-11"
                onClick={() => {
                  const token = session?.access_token;
                  if (!id || !token) return;
                  // A failed open goes back to the review, never straight to paying.
                  void load(id, token);
                }}
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Loading({ inline = false }: { inline?: boolean }) {
  return (
    <div
      className={`${inline ? "py-16" : "min-h-screen"} flex items-center justify-center text-muted-foreground`}
    >
      <span className="animate-pulse">Loading...</span>
    </div>
  );
}

function Notice(props: { title: string; summary: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4 text-center">{props.title}</h1>
      {props.summary && (
        <Card className="p-4 mb-4 text-sm">
          <p className="text-muted-foreground mb-1">What it buys</p>
          <p className="font-medium">{props.summary}</p>
        </Card>
      )}
      <p className="text-muted-foreground text-center">{props.children}</p>
    </div>
  );
}
