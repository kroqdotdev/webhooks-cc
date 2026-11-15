import { describe, expect, it } from "vitest";
import { createLatestCall, settleWrite } from "./latest-call";

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

describe("settleWrite", () => {
  it("applies a save that is still the newest call", () => {
    const calls = createLatestCall();
    const save = calls.begin();
    const applied: string[] = [];
    settleWrite(
      save,
      () => applied.push("apply"),
      () => applied.push("reload")
    );
    expect(applied).toEqual(["apply"]);
  });

  it("reads again when a read begun during the save superseded it", () => {
    // The read may have answered with the budget the save replaced, so the
    // panel must not stay on it: it reads once more, after the save landed.
    const calls = createLatestCall();
    const save = calls.begin();
    calls.begin();
    const applied: string[] = [];
    settleWrite(
      save,
      () => applied.push("apply"),
      () => applied.push("reload")
    );
    expect(applied).toEqual(["reload"]);
  });
});
