import { describe, expect, it } from "vitest";
import { assistsLeftText } from "./ai-assists-left";

const now = new Date(2026, 10, 3, 12, 0);

describe("assistsLeftText", () => {
  it("says only the count and the window when none are used", () => {
    expect(assistsLeftText({ allowed: 250, used: 0, nextAt: null }, now, "en-US")).toBe(
      "250 of 250 AI assists left. Each one counts for 30 days."
    );
  });

  it("names the day the next one comes back", () => {
    const nextAt = new Date(2026, 10, 14, 9, 0).toISOString();
    expect(assistsLeftText({ allowed: 250, used: 12, nextAt }, now, "en-US")).toBe(
      "238 of 250 AI assists left. Each one counts for 30 days; the next comes back on Nov 14."
    );
  });

  it("gives the time when the next one comes back today or tomorrow", () => {
    const today = new Date(2026, 10, 3, 18, 30).toISOString();
    const tomorrow = new Date(2026, 10, 4, 8, 15).toISOString();
    expect(assistsLeftText({ allowed: 5, used: 5, nextAt: today }, now, "en-GB")).toBe(
      "No AI assists left. The next one comes back today at 18:30."
    );
    expect(assistsLeftText({ allowed: 5, used: 5, nextAt: tomorrow }, now, "en-GB")).toBe(
      "No AI assists left. The next one comes back tomorrow at 08:15."
    );
  });

  it("says shortly once the time has passed", () => {
    const past = new Date(2026, 10, 3, 11, 0).toISOString();
    expect(assistsLeftText({ allowed: 5, used: 5, nextAt: past }, now, "en-GB")).toBe(
      "No AI assists left. The next one comes back shortly."
    );
  });

  it("copes with a missing or unreadable time", () => {
    expect(assistsLeftText({ allowed: 5, used: 5 }, now)).toBe("No AI assists left.");
    expect(assistsLeftText({ allowed: 20, used: 3, nextAt: "soon" }, now)).toBe(
      "17 of 20 AI assists left. Each one counts for 30 days."
    );
  });

  it("never shows a negative count after a plan moves down", () => {
    expect(assistsLeftText({ allowed: 20, used: 30, nextAt: null }, now)).toBe(
      "No AI assists left."
    );
  });
});
