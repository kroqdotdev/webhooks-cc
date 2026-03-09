"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com";

const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

// Initialize at module load time so posthog is ready before any React effects fire.
// This ensures the first pageview (landing page with referrer/UTM data) is never dropped.
if (typeof window !== "undefined" && POSTHOG_KEY) {
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    persistence: "memory",
    capture_pageview: false, // we handle this manually
    capture_pageleave: true,
    autocapture: true,
  });
}

function getUtmParams(searchParams: URLSearchParams): Record<string, string> {
  const utms: Record<string, string> = {};
  for (const key of UTM_PARAMS) {
    const value = searchParams.get(key);
    if (value) utms[key] = value;
  }
  return utms;
}

function getReferrerInfo(): Record<string, string> {
  const referrer = document.referrer;
  if (!referrer) return {};
  try {
    const url = new URL(referrer);
    // Don't count same-site navigation as a referrer
    if (url.hostname === window.location.hostname) return {};
    return {
      $referrer: referrer,
      referring_domain: url.hostname,
    };
  } catch {
    return { $referrer: referrer };
  }
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  if (!POSTHOG_KEY) return <>{children}</>;

  return <PHProvider client={posthog}>{children}</PHProvider>;
}

/** Track pageviews on route changes. Place inside PostHogProvider. */
export function PostHogPageview() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isFirstPageview = useRef(true);

  useEffect(() => {
    if (!POSTHOG_KEY || !pathname) return;

    const search = searchParams?.toString();
    const url = window.origin + pathname + (search ? `?${search}` : "");

    const properties: Record<string, unknown> = { $current_url: url };

    // Capture referrer and UTM params on the very first pageview (landing page)
    if (isFirstPageview.current) {
      isFirstPageview.current = false;
      properties.is_landing_page = true;
      properties.landing_path = pathname;
      Object.assign(properties, getReferrerInfo());
      if (searchParams) {
        Object.assign(properties, getUtmParams(searchParams));
      }
    }

    // Always include referrer info (for tracking internal → external → back flows)
    const referrer = getReferrerInfo();
    if (referrer.$referrer && !properties.$referrer) {
      Object.assign(properties, referrer);
    }

    posthog.capture("$pageview", properties);
  }, [pathname, searchParams]);

  return null;
}
