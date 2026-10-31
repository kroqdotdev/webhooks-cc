"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { redactShareTokens } from "@/lib/analytics-redact";
import { siteForHost } from "@/lib/site";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY as string, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      ui_host: "https://eu.posthog.com",
      persistence: "localStorage",
      capture_pageleave: true,
      autocapture: {
        dom_event_allowlist: ["click"],
        element_allowlist: ["a", "button"],
      },
      defaults: "2026-01-30",
      // Share link URLs hold their token; analytics never gets it.
      before_send: redactShareTokens,
      loaded: (ph) => {
        // Which of the two sites an event came from (lib/site.ts).
        ph.register({ site: siteForHost(window.location.host) });
        if (process.env.NODE_ENV === "development") ph.debug();
      },
    });
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
