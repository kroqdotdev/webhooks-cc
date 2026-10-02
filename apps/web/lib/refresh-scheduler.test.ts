import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRefreshScheduler } from "./refresh-scheduler";

describe("createRefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const run = vi.fn();
    const scheduler = createRefreshScheduler({ run, settleMs: 150, minIntervalMs: 1000 });
    return { run, scheduler };
  }

  test("runs once after the settle delay for a burst of notifications", () => {
    const { run, scheduler } = setup();
    scheduler.schedule();
    vi.advanceTimersByTime(100);
    scheduler.schedule();
    scheduler.schedule();
    vi.advanceTimersByTime(49);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("keeps runs at least minIntervalMs apart", () => {
    const { run, scheduler } = setup();
    scheduler.schedule();
    vi.advanceTimersByTime(150);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    vi.advanceTimersByTime(999);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("a steady stream still refreshes every minIntervalMs", () => {
    const { run, scheduler } = setup();
    for (let elapsed = 0; elapsed < 5000; elapsed += 50) {
      scheduler.schedule();
      vi.advanceTimersByTime(50);
    }
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(run.mock.calls.length).toBeLessThanOrEqual(5);
  });

  test("uses only the settle delay after a quiet period", () => {
    const { run, scheduler } = setup();
    scheduler.schedule();
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(5000);
    scheduler.schedule();
    vi.advanceTimersByTime(150);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("cancel drops a pending run", () => {
    const { run, scheduler } = setup();
    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(2000);
    expect(run).not.toHaveBeenCalled();
  });
});
