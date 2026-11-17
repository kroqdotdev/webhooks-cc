/**
 * The browser notices a session that ended elsewhere (signed out on every
 * device, the account deleted) by asking GoTrue about it: once when a page
 * loads with a session, and again when our API refuses a request. The proxy
 * only refreshes an expired session on a page load (proxy.ts), so this is
 * what turns a revoked one into a signed-out page.
 *
 * A 401 never signs anyone out by itself: an account that still owes its
 * second factor gets 401 from every route until it passes (lib/mfa.ts), and a
 * route answers 401 when it cannot reach GoTrue. Only GoTrue's answer decides.
 */

/** The parts of a GoTrue client this needs (supabase-js's `auth`). */
export interface SessionAuth {
  getUser(): Promise<{ error: { code?: string } | null }>;
  signOut(options: { scope: "local" }): Promise<unknown>;
}

/** Checks no more often than this, since a session that owes its code gets 401 on every call. */
export const SESSION_CHECK_MIN_INTERVAL_MS = 30_000;

/**
 * A check GoTrue has not answered by then counts as one that could not
 * finish: the fetch has no timeout of its own, and a hung one would hold
 * every later check (they share the one running) and the page load's
 * checked flag.
 */
export const SESSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * A session check that runs one at a time and at most once per interval. A
 * check asked for inside the interval is not dropped: one more runs when the
 * interval ends, so a session revoked just after the last check (or a check
 * that failed) is still noticed.
 *
 * auth-js clears the session itself when GoTrue says it no longer exists
 * (`session_not_found`), which signs the page out; a deleted user answers
 * `user_not_found` instead, which auth-js leaves alone, so that one signs out
 * here. A network failure or a 5xx changes nothing.
 */
export function createSessionCheck(
  auth: SessionAuth,
  opts: {
    now?: () => number;
    minIntervalMs?: number;
    schedule?: (run: () => void, ms: number) => unknown;
    /** Whether a trailing check still has a session to ask about when its time comes. */
    shouldRun?: () => boolean;
    timeoutMs?: number;
  } = {}
) {
  // A monotonic clock: a system clock set back must not hold checks off.
  const now = opts.now ?? (typeof performance !== "undefined" ? () => performance.now() : Date.now);
  const minIntervalMs = opts.minIntervalMs ?? SESSION_CHECK_MIN_INTERVAL_MS;
  const schedule = opts.schedule ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const shouldRun = opts.shouldRun ?? (() => true);
  const timeoutMs = opts.timeoutMs ?? SESSION_CHECK_TIMEOUT_MS;
  let running: Promise<void> | null = null;
  let lastStarted = Number.NEGATIVE_INFINITY;
  let trailing = false;

  return function checkSession(): Promise<void> {
    if (running) return running;
    const wait = lastStarted + minIntervalMs - now();
    if (wait > 0) {
      if (!trailing) {
        trailing = true;
        // Never longer than the interval, whatever the clock did; a timer that
        // fires early finds the interval still running and waits once more.
        schedule(
          () => {
            trailing = false;
            if (shouldRun()) void checkSession();
          },
          Math.min(wait, minIntervalMs)
        );
      }
      return Promise.resolve();
    }
    lastStarted = now();
    running = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          auth.getUser(),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
        if (answer?.error?.code === "user_not_found") await auth.signOut({ scope: "local" });
      } catch {
        // A check that could not finish says nothing about the session.
      } finally {
        clearTimeout(timer);
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
 * The call goes through exactly as made (same arguments, the window as
 * `this`), the response or the rejection comes back untouched, only the
 * status is read, and the callback is never awaited; a failure in it is
 * swallowed.
 */
export function watchApiUnauthorized(win: Window, onUnauthorized: () => void): void {
  const marked = win as Window & { __whkApiUnauthorizedWatch?: true };
  if (marked.__whkApiUnauthorizedWatch) return;
  marked.__whkApiUnauthorizedWatch = true;
  const original = win.fetch;
  win.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await original.apply(win, args);
    try {
      if (isApiUnauthorized(args[0], response, win.location.origin)) onUnauthorized();
    } catch {
      // Never let the check change what the caller gets.
    }
    return response;
  };
}

/**
 * Starts the browser's session checks: the fetch watch, which asks for a
 * check on a 401 from our API while `hasSession()` says the page holds a
 * session, and the check itself, returned for the load-time call.
 */
export function startSessionChecks(
  auth: SessionAuth,
  win: Window,
  hasSession: () => boolean,
  opts: Parameters<typeof createSessionCheck>[1] = {}
): () => Promise<void> {
  const checkSession = createSessionCheck(auth, { shouldRun: hasSession, ...opts });
  watchApiUnauthorized(win, () => {
    if (hasSession()) void checkSession();
  });
  return checkSession;
}

/**
 * The page load's part: reads the session the cookie holds, hands it to the
 * store, then checks it with GoTrue and marks it checked once that settles
 * (at once when there is no session, or the read failed). Until then a
 * session from the cookie may be one that ended elsewhere (RequireAuth).
 */
export async function loadSession<S>(steps: {
  getSession: () => Promise<S | null>;
  setSession: (session: S | null) => void;
  check: () => Promise<void>;
  markChecked: () => void;
}): Promise<void> {
  let session: S | null;
  try {
    session = await steps.getSession();
  } catch {
    // Resolve the loading state even if the read fails, so consumers don't
    // get stuck showing a loading placeholder forever.
    steps.setSession(null);
    steps.markChecked();
    return;
  }
  steps.setSession(session);
  if (session) await steps.check().catch(() => {});
  steps.markChecked();
}
