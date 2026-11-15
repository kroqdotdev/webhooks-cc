import { describe, expect, it } from "vitest";
import { askedAgo, countryName } from "./asked-from";

describe("asked-from", () => {
  it("names countries and Tor", () => {
    expect(countryName("DK")).toBe("Denmark");
    expect(countryName("T1")).toBe("the Tor network");
  });

  it("says how long ago, in minutes and then hours", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(askedAgo(now - 10_000, now)).toBe("Less than a minute ago");
    expect(askedAgo(now - 60_000, now)).toBe("1 minute ago");
    expect(askedAgo(now - 59 * 60_000, now)).toBe("59 minutes ago");
    expect(askedAgo(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(askedAgo(now - 5 * 60 * 60_000, now)).toBe("5 hours ago");
  });
});
