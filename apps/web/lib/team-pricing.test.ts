import { describe, expect, test } from "vitest";

import {
  DEFAULT_TEAM_SEATS,
  MAX_TEAM_SEATS,
  MIN_TEAM_SEATS,
  clampSeats,
  formatSeatPricing,
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
