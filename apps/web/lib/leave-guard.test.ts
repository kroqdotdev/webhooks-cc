import { afterEach, describe, expect, it, vi } from "vitest";
import {
  leaveThrough,
  navigationPending,
  navigationSettled,
  noteNavigation,
  setLeaveGuard,
} from "./leave-guard";

afterEach(() => {
  setLeaveGuard(null);
  navigationSettled();
  vi.useRealTimers();
});

describe("leaveThrough", () => {
  it("navigates at once without a guard", () => {
    const proceed = vi.fn();
    leaveThrough(proceed);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it("hands the navigation to the guard, which decides when it runs", () => {
    const proceed = vi.fn();
    let held: (() => void) | null = null;
    setLeaveGuard((go) => {
      held = go;
    });
    leaveThrough(proceed);
    expect(proceed).not.toHaveBeenCalled();
    held!();
    expect(proceed).toHaveBeenCalledTimes(1);
  });
});

describe("navigationPending", () => {
  it("is pending from the note until the navigation settles", () => {
    expect(navigationPending()).toBe(false);
    noteNavigation();
    expect(navigationPending()).toBe(true);
    navigationSettled();
    expect(navigationPending()).toBe(false);
  });

  it("stops counting a navigation that never lands", () => {
    vi.useFakeTimers();
    noteNavigation();
    vi.advanceTimersByTime(9_000);
    expect(navigationPending()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(navigationPending()).toBe(false);
  });
});
