import * as StatOSS from "@statoss/sdk";
import type { Breadcrumb, Event } from "@statoss/sdk";
import { redactEvent } from "./observability-redact";
import { pageWasTranslated } from "./translated-page";

/**
 * Browser errors to StatOSS: uncaught errors, unhandled rejections and what
 * the error boundaries catch (`reportBoundaryError`). Started from
 * `instrumentation-client.ts` when NEXT_PUBLIC_STATOSS_DSN is set at build
 * time. The DSN is public by design; its StatOSS key only accepts webhooks.cc
 * pages, has a low rate, and its app may use only part of the team's monthly
 * errors, so a flood cannot starve the server apps.
 *
 * What is sent loses query strings and fragments (a guest endpoint's slug or
 * a token can ride in one) and email addresses. Errors that are not ours
 * (browser extensions, cross-origin scripts, a link scanner's browser, a
 * dropped connection, a stale tab after a deploy, a translator rewriting the
 * page before it hydrated) are dropped.
 */

/** Messages that say the network, the browser or a stale tab failed, not our code. */
const NOISE = [
  /^Script error\.?$/,
  /ResizeObserver loop/,
  /^Failed to fetch$/,
  /^NetworkError when attempting to fetch resource\.?$/,
  /^Load failed$/,
  /^The operation was aborted\.?$/,
  /^Loading (CSS )?chunk [\w-]+ failed/,
  /the module factory is not available/,
  // Microsoft's link scanners (Outlook Safe Links, Bing) open pages in a
  // CefSharp browser whose own .NET bridge rejects with this string.
  /Object Not Found Matching Id:\d+, MethodName:\w+, ParamCount:\d+/,
];
const NOISE_TYPES = new Set(["AbortError", "ChunkLoadError"]);
const EXTENSION = /^(chrome|moz|safari|safari-web|ms-browser)-extension:\/\//;

/** True for an event about something other than our code. */
export function isNoise(event: Event): boolean {
  for (const exception of event.exception?.values ?? []) {
    if (NOISE_TYPES.has(exception.type)) return true;
    if (NOISE.some((pattern) => pattern.test(exception.value ?? ""))) return true;
    const files = (exception.stacktrace?.frames ?? [])
      .map((frame) => frame.abs_path ?? frame.filename ?? "")
      .filter(Boolean);
    // Frames, and none from our own bundles: an extension or a third-party script.
    if (files.length > 0 && !files.some((file) => file.includes("/_next/"))) return true;
    if (files.some((file) => EXTENSION.test(file))) return true;
  }
  return false;
}

const HYDRATION_MISMATCH = /Minified React error #418\b|^Hydration failed\b/;

/** True for React's report that the server HTML did not match the first client render. */
export function isHydrationMismatch(event: Event): boolean {
  return (event.exception?.values ?? []).some((exception) =>
    HYDRATION_MISMATCH.test(exception.value ?? "")
  );
}

/** True if an error indicates a missing or failed chunk/module (e.g. stale tab after deploy). */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: string; message?: string };
  return (
    err.name === "ChunkLoadError" ||
    /Loading (CSS )?chunk [\w-]+ failed/.test(err.message ?? "") ||
    /the module factory is not available/.test(err.message ?? "")
  );
}

/**
 * Attempts a one-time hard reload to fetch fresh assets if the error is a
 * stale-tab chunk/module load failure. Throttled to avoid reload loops.
 */
export function tryReloadOnChunkError(error: unknown): boolean {
  if (!isChunkLoadError(error) || typeof window === "undefined") return false;
  try {
    const key = "webhooks_chunk_reload";
    const last = window.sessionStorage?.getItem(key);
    const lastTs = last ? parseInt(last, 10) : NaN;
    const now = Date.now();
    if (Number.isNaN(lastTs) || now - lastTs > 15_000) {
      window.sessionStorage?.setItem(key, String(now));
      window.location.reload();
      return true;
    }
  } catch {
    // sessionStorage blocked or unavailable
  }
  return false;
}

/** A URL without its query string and fragment. */
export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (!breadcrumb.data) return breadcrumb;
  const data = { ...breadcrumb.data };
  for (const key of ["url", "from", "to"]) {
    if (typeof data[key] === "string") data[key] = withoutQuery(data[key]);
  }
  return { ...breadcrumb, data };
}

/** The event as it may leave the browser, or null to drop it. */
export function prepareBrowserEvent(event: Event): Event | null {
  if (isNoise(event)) return null;
  // The translator changed the HTML before React read it; see translated-page.ts.
  if (isHydrationMismatch(event) && pageWasTranslated()) return null;
  const scrubbed: Event = { ...event };
  if (scrubbed.request) {
    const request = { ...scrubbed.request };
    delete request.query_string;
    if (request.url) request.url = withoutQuery(request.url);
    scrubbed.request = request;
  }
  if (scrubbed.breadcrumbs) {
    scrubbed.breadcrumbs = { values: scrubbed.breadcrumbs.values.map(scrubBreadcrumb) };
  }
  return redactEvent(scrubbed);
}

export function startBrowserObservability(): boolean {
  const dsn = process.env.NEXT_PUBLIC_STATOSS_DSN?.trim();
  if (!dsn) return false;
  StatOSS.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_STATOSS_ENVIRONMENT?.trim() || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_STATOSS_RELEASE,
    beforeSend: (event) => prepareBrowserEvent(event),
  });
  return true;
}

/**
 * An error a React error boundary caught; those never reach the browser's
 * global handler. `boundary` names which one.
 */
export function reportBoundaryError(error: Error & { digest?: string }, boundary: string): void {
  StatOSS.captureException(error, {
    tags: { boundary, ...(error.digest ? { digest: error.digest } : {}) },
  });
}
