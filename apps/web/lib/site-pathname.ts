"use client";

import { usePathname } from "next/navigation";

/**
 * The path as the visitor sees it. mailhooks.cc's pages are prerendered
 * under app/mailhooks and reached through host rewrites (next.config.ts), so
 * on the server usePathname() reads "/mailhooks/docs/layouts" while the
 * browser reads "/docs/layouts". Dropping the prefix makes both read the
 * same, so active links and breadcrumbs hydrate without a mismatch.
 * webhooks.cc never shows a /mailhooks path (proxy.ts redirects it).
 */
export function sitePath(pathname: string): string {
  if (pathname === "/mailhooks") return "/";
  if (pathname.startsWith("/mailhooks/")) return pathname.slice("/mailhooks".length);
  return pathname;
}

export function useSitePathname(): string {
  return sitePath(usePathname() ?? "");
}
