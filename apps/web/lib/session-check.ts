/**
 * The browser notices a session that ended elsewhere (signed out on every
 * device, the account deleted) by asking GoTrue about it: once when a page
 * loads with a session, and again when our API refuses a request. The proxy
 * only refreshes an expired session (proxy.ts), so this is what turns a
 * revoked one into a signed-out page.
 *
 * A 401 never signs anyone out by itself: an account that still owes its
 * second factor gets 401 from every route until it passes (lib/mfa.ts), and a
 * route can answer 401 when its own database read fails. Only GoTrue's answer
 * decides.
 */

/** The parts of a GoTrue client this needs (supabase-js's `auth`). */
export interface SessionAuth {
  getUser(): Promise<{ error: { code?: string; name?: string } | null }>;
  signOut(options: { scope: "local" }): Promise<unknown>;
}

/** Checks no more often than this, since a session that owes its code gets 401 on every call. */
export const SESSION_CHECK_MIN_INTERVAL_MS = 30_000;

/**
 * A session check that runs one at a time and at most once per interval.
 *
 * auth-js clears the session itself when GoTrue says it no longer exists
 * (`session_not_found`), which signs the page out; a deleted user answers
 * `user_not_found` instead, which auth-js leaves alone, so that one signs out
 * here. A network failure or a 5xx changes nothing.
 */
export function createSessionCheck(
  auth: SessionAuth,
  opts: { now?: () => number; minIntervalMs?: number } = {}
) {
  const now = opts.now ?? Date.now;
  const minIntervalMs = opts.minIntervalMs ?? SESSION_CHECK_MIN_INTERVAL_MS;
  let running: Promise<void> | null = null;
  let lastStarted = Number.NEGATIVE_INFINITY;

  return function checkSession(): Promise<void> {
    if (running) return running;
    if (now() - lastStarted < minIntervalMs) return Promise.resolve();
    lastStarted = now();
    running = (async () => {
      try {
        const { error } = await auth.getUser();
        if (error?.code === "user_not_found") await auth.signOut({ scope: "local" });
      } catch {
        // A check that could not finish says nothing about the session.
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/** Whether a response is our API refusing the request (same origin, under /api/, 401). */
export function isApiUnauthorized(
  input: RequestInfo | URL,
  response: Response,
  origin: string
): boolean {
  if (response.status !== 401) return false;
  let url: URL;
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    url = new URL(href, origin);
  } catch {
    return false;
  }
  return url.origin === origin && (url.pathname === "/api" || url.pathname.startsWith("/api/"));
}

/**
 * Wraps the window's fetch once so a 401 from our API calls `onUnauthorized`.
 * The request and the response pass through untouched: only the status is
 * read, the callback is never awaited, and a failure in it is swallowed.
 */
export function watchApiUnauthorized(win: Window, onUnauthorized: () => void): void {
  const marked = win as Window & { __whkApiUnauthorizedWatch?: true };
  if (marked.__whkApiUnauthorizedWatch) return;
  marked.__whkApiUnauthorizedWatch = true;
  const original = win.fetch;
  win.fetch = async function fetchWatchingUnauthorized(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const response = await original.call(win, input, init);
    try {
      if (isApiUnauthorized(input, response, win.location.origin)) onUnauthorized();
    } catch {
      // Never let the check change what the caller gets.
    }
    return response;
  };
}
