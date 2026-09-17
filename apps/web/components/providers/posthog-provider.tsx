"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { registerStyleVariant, trackStyleExposure } from "@/lib/analytics";
import { readUiStyleState } from "@/lib/ui-style";

const EXPOSURE_SESSION_KEY = "ui-style-exposure-sent";

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
      loaded: (ph) => {
        if (process.env.NODE_ENV === "development") ph.debug();
      },
    });

    // Browsers that were never assigned a style stay out of the experiment.
    const { style, assigned } = readUiStyleState();
    if (!assigned) return;
    registerStyleVariant(assigned);
    try {
      if (!sessionStorage.getItem(EXPOSURE_SESSION_KEY)) {
        trackStyleExposure(assigned, style);
        sessionStorage.setItem(EXPOSURE_SESSION_KEY, "1");
      }
    } catch {
      // Blocked storage: skip the exposure rather than sending one per page view.
    }
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
