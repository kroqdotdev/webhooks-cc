/**
 * Coalesces bursts of change notifications into at most one run per
 * `minIntervalMs`. The first notification after a quiet period runs after
 * `settleMs`, so events that belong together (a request insert and its
 * signature update) share one run. Notifications that arrive while a run is
 * already scheduled never push it back, so a steady stream of events still
 * refreshes every `minIntervalMs` instead of waiting for the stream to stop.
 */
export function createRefreshScheduler({
  run,
  settleMs,
  minIntervalMs,
  now = () => Date.now(),
}: {
  run: () => void;
  settleMs: number;
  minIntervalMs: number;
  now?: () => number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRunAt = -Infinity;

  return {
    schedule() {
      if (timer !== undefined) return;
      const delay = Math.max(settleMs, lastRunAt + minIntervalMs - now());
      timer = setTimeout(() => {
        timer = undefined;
        lastRunAt = now();
        run();
      }, delay);
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
