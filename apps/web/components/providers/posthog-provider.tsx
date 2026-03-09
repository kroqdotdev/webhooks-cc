"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY as string, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      persistence: "memory",
      capture_pageleave: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      autocapture: {
        dom_event_allowlist: ["click"],
        element_allowlist: ["a", "button"],
      },
      defaults: "2026-01-30",
      loaded: (ph) => {
        if (process.env.NODE_ENV === "development") ph.debug();
      },
    });
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
