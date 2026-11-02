"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  acceptAnalytics,
  analyticsConsent,
  applyCarriedConsent,
  browserDeclinesTracking,
  declineAnalytics,
  OPEN_COOKIE_SETTINGS_EVENT,
  openCookieSettings,
} from "@/lib/analytics-consent";

/**
 * The analytics choice, asked once per site and browser, and again from any
 * "Cookie settings" link. Accept and Decline carry the same weight; the
 * banner never blocks the page. Everything else the site stores (the session,
 * theme and style picks) is needed to run it and is not asked about.
 */
export function CookieConsent() {
  const [open, setOpen] = useState(false);
  // Focus moves to the banner only when someone opened it from Cookie
  // settings; on a page load it is announced instead of taking focus.
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // After PostHogProvider's own effect has run posthog.init, which sets up
    // where the choice is read from. A switch from the other site may have
    // brought the answer along.
    const timer = setTimeout(() => {
      applyCarriedConsent();
      setOpen(analyticsConsent() === "pending");
    }, 0);
    const reopen = () => {
      setFocusOnOpen(true);
      setOpen(true);
    };
    window.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
    };
  }, []);

  useEffect(() => {
    if (open && focusOnOpen) dialogRef.current?.focus();
  }, [open, focusOnOpen]);

  if (!open) return null;

  // Reachable only from Cookie settings: the banner never opens by itself here.
  if (browserDeclinesTracking()) {
    return (
      <div
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        aria-live="polite"
        aria-labelledby="cookie-consent-title"
        className="ui-card ui-card-static fixed bottom-4 left-4 right-4 z-[60] p-5 outline-none sm:right-auto sm:max-w-md"
      >
        <p id="cookie-consent-title" className="font-bold">
          Analytics stay off
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Your browser asks sites not to track you (Do Not Track or Global Privacy Control), so we
          keep nothing in this browser and only count visits. Turn that setting off to choose here.
        </p>
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const choose = (accept: boolean) => {
    if (accept) acceptAnalytics();
    else declineAnalytics();
    // Storage can refuse the write (private modes, full quota); then the
    // choice did not stick, and the banner stays to say so by staying.
    if (analyticsConsent() === (accept ? "granted" : "denied")) setOpen(false);
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      aria-live="polite"
      aria-labelledby="cookie-consent-title"
      aria-describedby="cookie-consent-text"
      className="ui-card ui-card-static fixed bottom-4 left-4 right-4 z-[60] p-5 outline-none sm:right-auto sm:max-w-md"
    >
      <p id="cookie-consent-title" className="font-bold">
        Analytics, for us only
      </p>
      <p id="cookie-consent-text" className="mt-2 text-sm text-muted-foreground">
        We use PostHog to see how webhooks.cc is used, so we can improve it. Accept to let it keep
        an anonymous identifier in this browser. Decline and we only count visits without storing
        anything. Either way, we never sell or share your data. See our{" "}
        <a href="/privacy#analytics" className="underline hover:text-foreground">
          Privacy Policy
        </a>
        .
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Button variant="outline" size="sm" onClick={() => choose(false)}>
          Decline
        </Button>
        <Button size="sm" onClick={() => choose(true)}>
          Accept
        </Button>
      </div>
    </div>
  );
}

/** A footer or policy link that opens the banner again. */
export function CookieSettingsLink({ className }: { className?: string }) {
  // Without a PostHog key there is no banner to open.
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;
  return (
    <button type="button" className={className} onClick={openCookieSettings}>
      Cookie settings
    </button>
  );
}
