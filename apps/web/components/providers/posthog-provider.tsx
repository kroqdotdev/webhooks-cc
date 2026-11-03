"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { analyticsBeforeSend } from "@/lib/analytics-redact";
import { identifyPendingUser } from "@/lib/analytics";
import { ANALYTICS_CONSENT_KEY } from "@/lib/analytics-consent";
import { siteForHost } from "@/lib/site";
import { CookieConsent } from "@/components/providers/cookie-consent";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!POSTHOG_KEY) return;
    posthog.init(POSTHOG_KEY, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      ui_host: "https://eu.posthog.com",
      persistence: "localStorage",
      // Nothing is stored in the browser until the visitor accepts in the
      // cookie banner. Until then, and after a decline, events are sent
      // cookieless: PostHog counts visitors with a daily hash and keeps no
      // identifier here. Do Not Track and Global Privacy Control count as a
      // decline. The choice itself is kept under ANALYTICS_CONSENT_KEY.
      cookieless_mode: "on_reject",
      opt_out_capturing_by_default: true,
      opt_out_capturing_persistence_type: "localStorage",
      consent_persistence_name: ANALYTICS_CONSENT_KEY,
      respect_dnt: true,
      capture_pageleave: true,
      autocapture: {
        dom_event_allowlist: ["click"],
        element_allowlist: ["a", "button"],
      },
      defaults: "2026-01-30",
      // URLs lose share tokens, slugs and every unlisted query parameter;
      // nothing at all is sent from the operations center.
      before_send: (event) => analyticsBeforeSend(event, window.location.pathname),
      loaded: (ph) => {
        // Which of the two sites an event came from (lib/site.ts).
        ph.register({ site: siteForHost(window.location.host) });
        if (process.env.NODE_ENV === "development") ph.debug();
        // The session may have been reported before init, with the choice unreadable.
        identifyPendingUser();
      },
    });
  }, []);

  return (
    <PHProvider client={posthog}>
      {children}
      {POSTHOG_KEY ? <CookieConsent /> : null}
    </PHProvider>
  );
}
