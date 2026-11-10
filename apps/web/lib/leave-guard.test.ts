import { afterEach, describe, expect, it, vi } from "vitest";
import { leaveThrough, setLeaveGuard } from "./leave-guard";

afterEach(() => setLeaveGuard(null));

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
