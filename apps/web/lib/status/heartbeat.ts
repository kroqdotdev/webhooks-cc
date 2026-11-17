/**
 * Heartbeats for the public status page (status.webhooks.cc, on StatOSS).
 * A heartbeat monitor there goes down when its URL has not been asked for
 * within its period and grace, so a background job that stops, hangs or
 * fails quietly shows on the page even while every health route answers.
 * Each URL comes from the environment; unset, nothing is sent.
 */

const PING_TIMEOUT_MS = 10_000;
const WARN_EVERY_MS = 10 * 60_000;

const lastWarned = new Map<string, number>();

/** Asks a heartbeat URL once. Never throws: a ping that fails is a log line. */
export async function pingHeartbeat(
  url: string | undefined,
  label: string,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  if (!url) return false;
  try {
    const response = await fetcher(url, {
      method: "POST",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    // Drained, never cancelled: an unread body holds its connection, and a
    // cancel can hang Next's patched fetch.
    await response.arrayBuffer().catch(() => undefined);
    if (response.ok) return true;
    warnOnce(label, `answered ${response.status}`);
  } catch (error) {
    warnOnce(label, error instanceof Error ? error.name : "failed");
  }
  return false;
}

/** StatOSS being slow or down is not ours to page for: a warning now and then. */
function warnOnce(label: string, reason: string) {
  const now = Date.now();
  if (now - (lastWarned.get(label) ?? 0) < WARN_EVERY_MS) return;
  lastWarned.set(label, now);
  console.warn(`[status] ${label} heartbeat not sent: ${reason}`);
}

/**
 * Pings `url` every `everyMs` while `alive()` says the job is doing its
 * work; a job that is not stays silent, and the monitor goes down.
 */
export function startHeartbeat(options: {
  url: string | undefined;
  label: string;
  alive: () => boolean;
  everyMs?: number;
}): void {
  const { url, label, alive, everyMs = 60_000 } = options;
  if (!url) return;
  setInterval(() => {
    if (alive()) void pingHeartbeat(url, label);
  }, everyMs).unref();
}
