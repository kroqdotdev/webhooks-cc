import { describe, expect, it } from "vitest";
import { createLatestCall } from "./latest-call";

describe("createLatestCall", () => {
  it("lets a read begun before a save not apply once the save began", () => {
    const calls = createLatestCall();
    const read = calls.begin();
    const save = calls.begin();
    // The save's answer applies; the read's, arriving later, does not.
    expect(save()).toBe(true);
    expect(read()).toBe(false);
  });

  it("lets a read begun after a save win over it", () => {
    const calls = createLatestCall();
    const save = calls.begin();
    const read = calls.begin();
    expect(save()).toBe(false);
    expect(read()).toBe(true);
  });

  it("keeps a lone call current", () => {
    const calls = createLatestCall();
    const only = calls.begin();
    expect(only()).toBe(true);
    expect(only()).toBe(true);
  });
});
