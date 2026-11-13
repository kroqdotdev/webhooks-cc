import { describe, expect, it } from "vitest";
import { longDate, shortDate, shortDateUtc } from "./dates";

describe("dates", () => {
  it("reads a UTC date the same in every time zone", () => {
    // 23:30 UTC is already the next day east of Greenwich and still this one in UTC.
    expect(shortDateUtc("2026-11-13T23:30:00Z")).toBe("Nov 13, 2026");
    expect(shortDateUtc(Date.UTC(2026, 0, 1))).toBe("Jan 1, 2026");
  });

  it("formats local dates for lists and sentences", () => {
    expect(shortDate("2026-11-13T12:00:00")).toBe("Nov 13, 2026");
    expect(longDate("2026-11-13T12:00:00")).toBe("November 13, 2026");
  });
});
