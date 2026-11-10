import { describe, expect, it } from "vitest";
import { ENTITLEMENTS } from "@/lib/entitlements";
import { batchesOf, monthOf, nextMonthStart, overMessage } from "./usage";

const ID = "6f1c2a4e-1b2c-4d3e-8f90-1a2b3c4d5e6f";

describe("tunnel usage", () => {
  it("names the UTC month and when the next starts", () => {
    const now = Date.parse("2026-11-30T23:59:59Z");
    expect(monthOf(now)).toBe("2026-11-01");
    expect(nextMonthStart(now).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("keeps only well-formed batches and counts of previews", () => {
    const batches = batchesOf([
      {
        id: "b1",
        usage: [
          { id: ID, kind: "share", bytes: 10, requests: 1 },
          { id: ID, kind: "site", bytes: 10, requests: 1 },
          { id: "not-a-uuid", bytes: 10, requests: 1 },
          { id: ID, bytes: -1, requests: 1 },
          { id: ID, bytes: 0, requests: 0 },
          { id: ID, bytes: 1.5, requests: 1 },
        ],
        arrivals: [{ ignored: true }],
      },
      { id: "", usage: [] },
      { id: "x".repeat(81), usage: [] },
      "nonsense",
    ]);
    expect(batches).toEqual([{ id: "b1", usage: [{ id: ID, bytes: 10, requests: 1 }] }]);
    expect(batchesOf(null)).toEqual([]);
  });

  it("says when previews open again", () => {
    const plan = {
      key: "free" as const,
      label: "Free",
      limits: ENTITLEMENTS.free,
      notice: true,
      teamId: null,
      teamIds: [],
    };
    const message = overMessage({
      plan,
      month: "2026-11",
      bytes: 2,
      requests: 1,
      allowanceBytes: 1,
      resetsAt: new Date("2026-12-01T00:00:00Z"),
      over: true,
    });
    expect(message).toContain("1 GB");
    expect(message).toContain("1 December");
    expect(message).toContain("bigger plan");
  });
});
