"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { askedAgo, countryName } from "@/lib/asked-from";
import { networkNotice } from "@/lib/device-login-notice";

/** What GET /api/billing/checkouts/{id}/review answers. */
export interface CheckoutReviewData {
  id: string;
  status: "open" | "paid" | "expired" | "superseded" | "processing";
  kind: "plan" | "team_plan" | "blocks" | "monthly_blocks" | "overage";
  /** What blocks or overage are of (requests, pages, domains); null for a plan. */
  resource: string | null;
  summary: string;
  price: string | null;
  email: string | null;
  teamName: string | null;
  /** Who asked: the kind, and the name and key prefix the asker chose. */
  requester: { kind: "agent" | "key" | "session"; name: string | null; prefix: string | null };
  /** Why the account cannot buy this now; null when it can. */
  unavailable: string | null;
  /** The refusal's code: checkout_in_progress is for now only (Try again). */
  unavailableCode?: string | null;
  /** An expired link's reason: "unsettled" when it may have been paid, "cancelled" when cancelled. */
  expiredReason?: "unsettled" | "cancelled" | null;
  country: string | null;
  network: "same" | "different" | "unknown";
  createdAt: string;
  expiresAt: string;
}

/**
 * The confirmation a checkout link's page shows before anything is made
 * (app/checkout/[id]/page.tsx): what it buys and costs, the account or team
 * that pays, who asked, when and from where, with the approval page's
 * warning when the link came from another network. Only its button goes on
 * to payment.
 */
export function CheckoutReview(props: {
  review: CheckoutReviewData;
  opening: boolean;
  onContinue: () => void;
}) {
  const { review } = props;
  const notice = networkNotice(review.network, false, "checkout link", "Pay for");

  return (
    <div data-testid="checkout-review">
      <h1 className="text-2xl font-bold mb-2 text-center">Pay for this?</h1>
      <p className="text-muted-foreground mb-6 text-center">
        This checkout link is for{" "}
        {review.teamName ? (
          <>
            the team <span className="font-medium text-foreground">{review.teamName}</span>, paid
            from your account
          </>
        ) : (
          "your account"
        )}
        {review.email ? (
          <>
            {" "}
            <span className="font-mono text-foreground break-all">{review.email}</span>
          </>
        ) : null}
        .
      </p>

      <Card className="p-4 mb-4 space-y-3 text-sm" render={<dl />}>
        <div>
          <dt className="text-muted-foreground mb-1">What it buys</dt>
          <dd className="font-medium">{review.summary}</dd>
        </div>
        {review.price && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground shrink-0">Price</dt>
            <dd className="text-right">
              {review.price}, plus any tax Polar adds. Polar&apos;s page shows the final amount.
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground shrink-0">Asked by</dt>
          <dd className="text-right break-words ph-no-capture">
            <Requester requester={review.requester} />
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground shrink-0">Asked from</dt>
          <dd className="text-right">{review.country ? countryName(review.country) : "Unknown"}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground shrink-0">Asked</dt>
          <dd className="text-right">{askedAgo(Date.parse(review.createdAt))}</dd>
        </div>
      </Card>

      {notice && (
        <div
          className={
            notice.level === "warning"
              ? "text-sm text-destructive-ink bg-destructive/10 border border-destructive/40 rounded-md p-3 mb-4"
              : "text-sm border rounded-md p-3 mb-4"
          }
          role={notice.level === "warning" ? "alert" : "note"}
        >
          {notice.text}
        </div>
      )}

      <p className="text-sm text-muted-foreground mb-4 text-center">
        Nothing is charged here. Continuing takes you to Polar, who handles payments for
        webhooks.cc, where you pay with your own card. If you did not ask an agent or tool for this,
        close the page.
      </p>

      <Button
        className="w-full h-12 text-base"
        disabled={props.opening}
        onClick={props.onContinue}
        data-testid="checkout-continue"
      >
        {props.opening ? "Opening the checkout..." : "Continue to payment"}
      </Button>
    </div>
  );
}

/**
 * Who asked, with the name the key or agent chose set apart in its own
 * monospaced element, never inside quotes in a sentence, so it cannot read
 * as part of the page's own words.
 */
function Requester({ requester }: { requester: CheckoutReviewData["requester"] }) {
  const name = requester.name ? (
    <span className="font-mono text-foreground" data-testid="checkout-requester-name">
      {requester.name}
    </span>
  ) : null;
  if (requester.kind === "agent") {
    return name ? <>A connected agent named {name}</> : <>A connected agent</>;
  }
  if (requester.kind === "key") {
    const prefix = requester.prefix ? (
      <span className="font-mono text-muted-foreground">{requester.prefix}...</span>
    ) : null;
    if (name) {
      return (
        <>
          An API key named {name}
          {prefix ? <> ({prefix})</> : null}
        </>
      );
    }
    return prefix ? <>An API key {prefix}</> : <>An API key</>;
  }
  return <>A signed-in session (or a key or agent removed since)</>;
}
