import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, retryDelaySeconds } from "./schedule";

describe("retryDelaySeconds", () => {
  it("backs off from 30 s to 12 h, about a day in all, then stops", () => {
    const delays = Array.from({ length: MAX_ATTEMPTS }, (_, i) => retryDelaySeconds(i + 1));
    expect(delays).toEqual([30, 120, 600, 1800, 3600, 10_800, 21_600, 43_200, null]);
    const total = delays.reduce<number>((sum, delay) => sum + (delay ?? 0), 0);
    expect(total / 3600).toBeCloseTo(22.7, 0);
  });

  it("has no retry before the first try or for nonsense", () => {
    expect(retryDelaySeconds(0)).toBeNull();
    expect(retryDelaySeconds(1.5)).toBeNull();
    expect(retryDelaySeconds(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});
