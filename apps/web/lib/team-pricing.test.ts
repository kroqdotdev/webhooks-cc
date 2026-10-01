import { describe, expect, test } from "vitest";

import {
  DEFAULT_TEAM_SEATS,
  MAX_TEAM_SEATS,
  MIN_TEAM_SEATS,
  clampSeats,
  estimateSeatProration,
  formatSeatPricing,
  formatUsd,
} from "./team-pricing";

describe("formatSeatPricing", () => {
  test("renders the seat count, unit price and monthly total", () => {
    expect(formatSeatPricing(3)).toBe("3 × $12/seat/mo = $36/mo");
  });

  test("handles a single seat", () => {
    expect(formatSeatPricing(1)).toBe("1 × $12/seat/mo = $12/mo");
  });

  test("scales the total with the seat count", () => {
    expect(formatSeatPricing(25)).toBe("25 × $12/seat/mo = $300/mo");
  });
});

describe("clampSeats", () => {
  test("keeps values inside the allowed range", () => {
    expect(clampSeats(7)).toBe(7);
    expect(clampSeats(MIN_TEAM_SEATS)).toBe(MIN_TEAM_SEATS);
    expect(clampSeats(MAX_TEAM_SEATS)).toBe(MAX_TEAM_SEATS);
  });

  test("clamps below the minimum and above the maximum", () => {
    expect(clampSeats(0)).toBe(MIN_TEAM_SEATS);
    expect(clampSeats(-4)).toBe(MIN_TEAM_SEATS);
    expect(clampSeats(MAX_TEAM_SEATS + 1)).toBe(MAX_TEAM_SEATS);
  });

  test("truncates fractional input", () => {
    expect(clampSeats(3.9)).toBe(3);
  });

  test("falls back to the default when the input is not a number", () => {
    expect(clampSeats(NaN)).toBe(DEFAULT_TEAM_SEATS);
    expect(clampSeats(Infinity)).toBe(DEFAULT_TEAM_SEATS);
  });
});

describe("estimateSeatProration", () => {
  const periodEnd = Date.parse("2026-10-30T00:41:48Z");

  test("charges a full seat at the start of the period", () => {
    const start = Date.parse("2026-09-30T00:41:48Z");
    expect(estimateSeatProration(1, periodEnd, start)).toBeCloseTo(12, 5);
  });

  test("prorates by the time left in the billing month", () => {
    // Kargo's fourth seat: added 20:40 UTC on the first day of a 30-day month.
    const added = Date.parse("2026-09-30T20:40:32Z");
    expect(estimateSeatProration(1, periodEnd, added)).toBeCloseTo(11.67, 2);
  });

  test("scales with the number of seats and ignores direction", () => {
    const midway = Date.parse("2026-10-15T00:41:48Z");
    expect(estimateSeatProration(3, periodEnd, midway)).toBeCloseTo(18, 5);
    expect(estimateSeatProration(-3, periodEnd, midway)).toBeCloseTo(18, 5);
  });

  test("is zero once the period has ended and unknown without a period", () => {
    expect(estimateSeatProration(1, periodEnd, periodEnd + 1000)).toBe(0);
    expect(estimateSeatProration(1, null)).toBeNull();
  });
});

describe("formatUsd", () => {
  test("always shows cents", () => {
    expect(formatUsd(11.666)).toBe("$11.67");
    expect(formatUsd(12)).toBe("$12.00");
  });
});
