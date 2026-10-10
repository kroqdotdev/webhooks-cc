import { describe, expect, test } from "vitest";

import {
  DEFAULT_TEAM_SEATS,
  MAX_TEAM_SEATS,
  MIN_TEAM_SEATS,
  clampSeats,
  creditBalanceFromOrders,
  formatCents,
  formatSeatPricing,
  quoteSeatChange,
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

// Sandbox subscription used to pin Polar's arithmetic (2026-10-01, tax-inclusive).
const PERIOD_START = Date.parse("2026-10-01T13:26:22.426Z");
const PERIOD_END = Date.parse("2026-11-01T13:26:22.426Z");
const base = {
  pricePerSeatCents: 1200,
  periodStartMs: PERIOD_START,
  periodEndMs: PERIOD_END,
  creditBalanceCents: 0,
};

describe("quoteSeatChange", () => {
  test("matches Polar: one seat 22 seconds in costs $11.99, rounded down", () => {
    const quote = quoteSeatChange({
      ...base,
      currentSeats: 2,
      newSeats: 3,
      nowMs: Date.parse("2026-10-01T13:26:44.266Z"),
    });
    expect(quote.prorationCents).toBe(1199);
    expect(quote.dueNowCents).toBe(1199);
    expect(quote.renewalCents).toBe(3600);
  });

  test("matches Polar: rounds the total down, not each seat", () => {
    const quote = quoteSeatChange({
      ...base,
      currentSeats: 3,
      newSeats: 5,
      nowMs: Date.parse("2026-10-01T13:26:52.094Z"),
    });
    expect(quote.prorationCents).toBe(2399);
  });

  test("a reduction waits for the renewal: nothing charged or credited now", () => {
    const quote = quoteSeatChange({
      ...base,
      currentSeats: 5,
      pendingSeats: null,
      newSeats: 4,
      nowMs: Date.parse("2026-10-01T13:26:59.645Z"),
    });
    expect(quote.appliesAtRenewal).toBe(true);
    expect(quote.prorationCents).toBe(0);
    expect(quote.dueNowCents).toBe(0);
    expect(quote.creditAppliedCents).toBe(0);
    expect(quote.renewalCents).toBe(4800);
  });

  test("carries a pending reduction through so the dialog can mention it", () => {
    const quote = quoteSeatChange({
      ...base,
      currentSeats: 5,
      pendingSeats: 3,
      newSeats: 6,
      nowMs: PERIOD_START,
    });
    expect(quote.pendingSeats).toBe(3);
    expect(quote.appliesAtRenewal).toBe(false);
    // Polar charges an increase from the current seats, not the pending ones.
    expect(quote.dueNowCents).toBe(1200);
  });

  test("matches Polar: unused credit is spent before the card", () => {
    const quote = quoteSeatChange({
      ...base,
      currentSeats: 4,
      newSeats: 5,
      creditBalanceCents: 1199,
      nowMs: Date.parse("2026-10-01T13:27:06.735Z"),
    });
    expect(quote.prorationCents).toBe(1199);
    expect(quote.creditAppliedCents).toBe(1199);
    expect(quote.dueNowCents).toBe(0);
  });

  test("charges the full price at the start of the period and nothing after it ends", () => {
    expect(
      quoteSeatChange({ ...base, currentSeats: 1, newSeats: 2, nowMs: PERIOD_START }).dueNowCents
    ).toBe(1200);
    expect(
      quoteSeatChange({ ...base, currentSeats: 1, newSeats: 2, nowMs: PERIOD_END + 1000 })
        .dueNowCents
    ).toBe(0);
  });

  // The amounts of a real Polar order: a fourth seat about 20 hours into the period.
  test("a fourth seat added 20 hours into the period costs $11.66", () => {
    const quote = quoteSeatChange({
      currentSeats: 3,
      newSeats: 4,
      pricePerSeatCents: 1200,
      periodStartMs: Date.parse("2026-09-30T00:41:48.478Z"),
      periodEndMs: Date.parse("2026-10-30T00:41:48.478Z"),
      creditBalanceCents: 0,
      nowMs: Date.parse("2026-09-30T20:40:32.260Z"),
    });
    expect(quote.dueNowCents).toBe(1166);
  });
});

describe("creditBalanceFromOrders", () => {
  test("adds credit notes and subtracts credit already spent", () => {
    const orders = [
      { totalAmount: 2400, appliedBalanceAmount: 0 },
      { totalAmount: -1199, appliedBalanceAmount: 0 },
    ];
    expect(creditBalanceFromOrders(orders)).toBe(1199);
    expect(
      creditBalanceFromOrders([...orders, { totalAmount: 1199, appliedBalanceAmount: -1199 }])
    ).toBe(0);
  });

  test("never goes negative", () => {
    expect(creditBalanceFromOrders([{ totalAmount: 100, appliedBalanceAmount: -50 }])).toBe(0);
  });
});

describe("formatCents", () => {
  test("formats cents as dollars", () => {
    expect(formatCents(1166)).toBe("$11.66");
    expect(formatCents(1200)).toBe("$12.00");
    expect(formatCents(-1199)).toBe("-$11.99");
  });
});
