import { describe, expect, it } from "vitest";
import { describeStopped, reasonOf } from "./ops-request";
import { blockNameProblem, blockWordProblem } from "./moderation";

describe("ops sharing helpers", () => {
  it("says what a stop did", () => {
    expect(describeStopped(0, false)).toBe("Nothing was live.");
    expect(describeStopped(1, true)).toBe("Stopped 1 preview.");
    expect(describeStopped(2, false)).toMatch(/^Stopped 2 previews\. The edge did not answer/);
  });

  it("takes a reason of 3 to 300 characters", () => {
    expect(reasonOf("  phishing kit ")).toBe("phishing kit");
    expect(reasonOf("ab")).toBeNull();
    expect(reasonOf("x".repeat(301))).toBeNull();
    expect(reasonOf(7)).toBeNull();
  });

  it("blocks any DNS label as a name, free names included, and plain words", () => {
    expect(blockNameProblem("amber-badger-0042-free")).toBeNull();
    expect(blockNameProblem("acme")).toBeNull();
    expect(blockNameProblem("-acme")).not.toBeNull();
    expect(blockNameProblem("acme.login")).not.toBeNull();
    expect(blockWordProblem("bankid")).toBeNull();
    expect(blockWordProblem("bank-id")).not.toBeNull();
    expect(blockWordProblem("ab")).not.toBeNull();
  });
});
