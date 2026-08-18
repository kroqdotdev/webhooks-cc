import { describe, expect, test } from "vitest";

import {
  ACTIVATION_MAX_POLLS,
  ACTIVATION_POLL_INTERVAL_MS,
  ACTIVATION_TIMEOUT_MS,
  hasActivationTimedOut,
} from "./team-activation";

describe("activation polling schedule", () => {
  test("polls every 3s for at most 60s", () => {
    expect(ACTIVATION_POLL_INTERVAL_MS).toBe(3_000);
    expect(ACTIVATION_TIMEOUT_MS).toBe(60_000);
    expect(ACTIVATION_MAX_POLLS).toBe(20);
  });
});

describe("hasActivationTimedOut", () => {
  test("keeps polling inside the window", () => {
    expect(hasActivationTimedOut(1_000, 1_000)).toBe(false);
    expect(hasActivationTimedOut(1_000, 1_000 + ACTIVATION_POLL_INTERVAL_MS)).toBe(false);
    expect(hasActivationTimedOut(1_000, 1_000 + ACTIVATION_TIMEOUT_MS - 1)).toBe(false);
  });

  test("stops once the window has elapsed", () => {
    expect(hasActivationTimedOut(1_000, 1_000 + ACTIVATION_TIMEOUT_MS)).toBe(true);
    expect(hasActivationTimedOut(1_000, 1_000 + ACTIVATION_TIMEOUT_MS + 5_000)).toBe(true);
  });

  test("a clock that jumps backwards does not end the window early", () => {
    expect(hasActivationTimedOut(10_000, 5_000)).toBe(false);
  });
});
