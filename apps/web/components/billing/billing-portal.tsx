"use client";

import { useEffect, useState } from "react";
import { InlineMessage } from "@/components/settings/panel";
import { Button } from "@/components/ui/button";
import { createBillingPortalLink } from "@/lib/billing-api";

/** What the portal control is called everywhere it is pointed at. */
export const BILLING_PORTAL_LABEL = "Invoices and payment method";

/**
 * Opens Polar's customer portal (invoices, receipts, payment method) for the
 * account, or for `teamId` when its owner asks. The link is made on click and
 * followed at once: it signs the browser in as the customer for an hour.
 */
function useBillingPortal(accessToken: string | null, teamId?: string) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Back from the portal, a page restored from the back-forward cache would
  // still show "Opening...".
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setOpening(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const open = async () => {
    if (!accessToken) {
      setError("Your session expired. Please sign in again.");
      return;
    }
    setOpening(true);
    setError(null);
    try {
      window.location.assign(await createBillingPortalLink(accessToken, teamId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open billing. Please try again.");
      setOpening(false);
    }
  };

  return { open, opening, error };
}

export function BillingPortalButton({
  accessToken,
  teamId,
}: {
  accessToken: string | null;
  teamId?: string;
}) {
  const { open, opening, error } = useBillingPortal(accessToken, teamId);
  return (
    <>
      <Button variant="outline" onClick={() => void open()} disabled={opening || !accessToken}>
        {opening ? "Opening..." : BILLING_PORTAL_LABEL}
      </Button>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </>
  );
}

/** The portal as a link inside a sentence, for "update your card" notices. */
export function BillingPortalLink({
  accessToken,
  teamId,
  children,
}: {
  accessToken: string | null;
  teamId?: string;
  children: React.ReactNode;
}) {
  const { open, opening, error } = useBillingPortal(accessToken, teamId);
  return (
    <>
      <button
        type="button"
        onClick={() => void open()}
        disabled={opening || !accessToken}
        className="underline underline-offset-2 hover:text-foreground disabled:opacity-60"
      >
        {children}
      </button>
      {error && (
        <span role="alert" className="block text-destructive">
          {error}
        </span>
      )}
    </>
  );
}
