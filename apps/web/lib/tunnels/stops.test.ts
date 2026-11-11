import { describe, expect, it } from "vitest";
import { describeEnding, FINAL_ENDINGS, STOPS, tellFor } from "./stops";

describe("stops", () => {
  it("tells the CLI why a run ended", () => {
    expect(tellFor("stopped")).toBe(STOPS.stopped.tell);
    expect(tellFor("time limit")).toBe("it reached the plan's time limit");
    expect(tellFor("something else")).toBe("it ended on webhooks.cc");
    expect(tellFor(null)).toBe("it ended on webhooks.cc");
  });

  it("describes endings for the Shares page", () => {
    expect(describeEnding(null)).toBeNull();
    expect(describeEnding("closed")).toBeNull();
    expect(describeEnding("replaced")).toMatch(/newer share/);
    expect(describeEnding(STOPS.blocked.record)).toBe(STOPS.blocked.ending);
  });

  it("lets a dropped or replaced run reconnect, but not a stopped one", () => {
    expect(FINAL_ENDINGS).toContain("time limit");
    expect(FINAL_ENDINGS).toContain(STOPS.revoked.record);
    expect(FINAL_ENDINGS).not.toContain("replaced");
    expect(FINAL_ENDINGS).not.toContain("edge restart");
    expect(FINAL_ENDINGS).not.toContain("closed");
  });

  it("keeps every recorded reason within the column's 40 characters", () => {
    for (const stop of Object.values(STOPS)) expect(stop.record.length).toBeLessThanOrEqual(40);
  });
});
