import * as StatOSS from "@statoss/sdk";

/**
 * Errors to StatOSS, server side. `instrumentation.ts` starts the client
 * (`observability-start.ts`) when STATOSS_DSN is set; without it every call
 * here only logs. The client keeps its state on `globalThis`, so route
 * bundles reach the one instrumentation started.
 *
 * Report what is our fault and needs someone: a failed query, a billing call
 * that broke, a worker that cannot do its job. Not a 4xx, a rate limit, or a
 * customer's own URL failing; those stay log lines at most.
 *
 * One failure can repeat for every request (the database gone fails each
 * route the same way), so each site sends at most one event a minute; the
 * rest are counted onto the next one as `suppressed`. Console lines still go
 * out every time and reach StatOSS as log lines.
 */

const WINDOW_MS = 60_000;
/** Sites are fixed strings; this only bounds the map if one is not. */
const MAX_SITES = 500;

const sites = new Map<string, { start: number; suppressed: number }>();

/** Whether `key` may send an event at `now`, and how many it held back since the last. */
export function admit(key: string, now: number): { send: boolean; suppressed: number } {
  const site = sites.get(key);
  if (site && now - site.start < WINDOW_MS) {
    site.suppressed++;
    return { send: false, suppressed: 0 };
  }
  if (!site && sites.size >= MAX_SITES) sites.clear();
  sites.set(key, { start: now, suppressed: 0 });
  return { send: true, suppressed: site?.suppressed ?? 0 };
}

/** For tests. */
export function resetThrottle(): void {
  sites.clear();
}

/** A short text for a value that is not an Error: a query error, a sanitized Polar error. */
export function describe(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 500);
  if (value && typeof value === "object") {
    const { message, code } = value as { message?: unknown; code?: unknown };
    if (typeof message === "string") {
      return typeof code === "string" && code ? `${message} (${code})` : message.slice(0, 500);
    }
    try {
      return JSON.stringify(value).slice(0, 500);
    } catch {
      // A cycle; fall through.
    }
  }
  return String(value).slice(0, 500);
}

/**
 * Logs `where: error` and reports it as an issue grouped by `where`. `where`
 * is a fixed string naming the site ("Failed to list endpoints"), never one
 * built from request data.
 */
export function reportError(where: string, error?: unknown, extra?: Record<string, unknown>): void {
  const line: unknown[] = [error === undefined ? where : `${where}:`];
  if (error !== undefined) line.push(error);
  if (extra) line.push(extra);
  console.error(...line);

  const { send, suppressed } = admit(where, Date.now());
  if (!send) return;
  const context = {
    level: "error" as const,
    fingerprint: [where],
    tags: { where },
    extra: { ...extra, ...(suppressed > 0 ? { suppressed } : {}) },
  };
  if (error instanceof Error) {
    StatOSS.captureException(error, context);
  } else {
    StatOSS.captureMessage(error === undefined ? where : `${where}: ${describe(error)}`, {
      ...context,
      extra: { ...context.extra, ...(error === undefined ? {} : { detail: error }) },
    });
  }
}

/**
 * An error a route or page threw, from `onRequestError`. Next has logged it
 * already. Tagged with the route's pattern (`/api/stream/[slug]`), not the
 * path, so slugs and query strings stay out.
 */
export function reportRequestError(
  error: unknown,
  request: { method: string },
  context: { routePath: string; routeType: string }
): void {
  const message = error instanceof Error ? error.message : describe(error);
  const { send, suppressed } = admit(`${context.routePath} ${message}`.slice(0, 300), Date.now());
  if (!send) return;
  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : undefined;
  StatOSS.captureException(error, {
    tags: {
      route: context.routePath,
      routeType: context.routeType,
      method: request.method,
      ...(digest ? { digest } : {}),
    },
    extra: suppressed > 0 ? { suppressed } : {},
  });
}
