"use client";

import { useEffect } from "react";

/**
 * A tool page that calls a provider needs the Content-Security-Policy of its
 * own address (lib/tools/csp.ts), and a document keeps the policy it was
 * loaded with. Reached through a client-side navigation, the page would run
 * under another page's policy and every request would be blocked, so it
 * loads itself once as a document of its own. That happens on arrival,
 * before anything has been typed.
 *
 * The reverse holds when leaving: a page reached from a sender page by a
 * client-side navigation (a header link, the breadcrumb, Back) would keep the
 * sender page's wider connect-src. So when the sender page goes away and the
 * address is no longer its own, the new page is loaded as a document too.
 */

/** Whether the document was loaded from this path, given its navigation entry's URL. */
export function documentLoadedAs(path: string, loadedUrl: string | undefined): boolean {
  // No entry (a very old browser): nothing to compare, so leave the page be.
  if (!loadedUrl) return true;
  try {
    const loaded = new URL(loadedUrl).pathname.replace(/\/+$/, "") || "/";
    return loaded === path;
  } catch {
    return true;
  }
}

const RELOADED_KEY = "webhooks_tool_document";

/** Reloads the page once when its document was first loaded as some other page. */
export function useOwnDocument(path: string): void {
  useEffect(() => {
    const [entry] = performance.getEntriesByType("navigation");
    if (documentLoadedAs(path, entry?.name)) {
      // This document carries the sender page's policy. Leaving it without a
      // document load would hand that policy to the next page, so reload there.
      return () => {
        window.setTimeout(() => {
          if (!documentLoadedAs(path, window.location.href)) window.location.reload();
        }, 0);
      };
    }
    try {
      // Once per arrival: a reload that still does not match must not loop.
      const last = Number(window.sessionStorage.getItem(RELOADED_KEY));
      if (Number.isFinite(last) && Date.now() - last < 10_000) return;
      window.sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
    } catch {
      // Storage blocked: without a way to remember, do not risk a loop.
      return;
    }
    window.location.reload();
  }, [path]);
}
