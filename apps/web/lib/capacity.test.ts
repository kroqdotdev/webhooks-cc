import { describe, expect, it } from "vitest";
import {
  BLOCK_REQUESTS,
  MAX_BLOCKS,
  OVERAGE_BLOCK_CENTS,
  blocksFromRequests,
  isCapacityExhausted,
  overageCents,
  parseBlockCount,
  parseRequestAmount,
  periodOverageUsed,
  remainingCapacity,
  type CapacityFields,
} from "./capacity";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const PERIOD_START = "2026-10-15T00:00:00Z";

function account(overrides: Partial<CapacityFields> = {}): CapacityFields {
  return {
    requests_used: 100_000,
    request_limit: 100_000,
    block_requests: 0,
    credit_requests: 0,
    overage_active: false,
    overage_max: 0,
    overage_used: 0,
    overage_period_start: null,
    period_start: PERIOD_START,
    period_end: "2026-11-15T00:00:00Z",
    ...overrides,
  };
}

describe("prices", () => {
  it("charges overage per request at $4 per block, rounded to the cent", () => {
    expect(overageCents(BLOCK_REQUESTS)).toBe(OVERAGE_BLOCK_CENTS);
    expect(overageCents(11_750)).toBe(188);
    expect(overageCents(0)).toBe(0);
    expect(overageCents(-5)).toBe(0);
  });

  it("converts requests to whole blocks only", () => {
    expect(blocksFromRequests(50_000)).toBe(2);
    expect(blocksFromRequests(30_000)).toBeNull();
    expect(blocksFromRequests(0)).toBeNull();
  });

  it("accepts block counts from 1 (or 0 when allowed) to the maximum", () => {
    expect(parseBlockCount(1)).toBe(1);
    expect(parseBlockCount(MAX_BLOCKS)).toBe(MAX_BLOCKS);
    expect(parseBlockCount(0)).toBeNull();
    expect(parseBlockCount(0, { allowZero: true })).toBe(0);
    expect(parseBlockCount(MAX_BLOCKS + 1)).toBeNull();
    expect(parseBlockCount(1.5)).toBeNull();
    expect(parseBlockCount("2")).toBeNull();
  });
});

describe("periodOverageUsed", () => {
  it("counts overage only for the period it was stamped with", () => {
    expect(
      periodOverageUsed({
        overage_used: 7,
        overage_period_start: PERIOD_START,
        period_start: PERIOD_START,
      })
    ).toBe(7);
    expect(
      periodOverageUsed({
        overage_used: 7,
        overage_period_start: "2026-09-15T00:00:00Z",
        period_start: PERIOD_START,
      })
    ).toBe(0);
    expect(
      periodOverageUsed({ overage_used: 7, overage_period_start: null, period_start: PERIOD_START })
    ).toBe(0);
  });
});

describe("isCapacityExhausted and remainingCapacity", () => {
  it("is exhausted only when the allowance, one-time blocks and overage are all used", () => {
    expect(isCapacityExhausted(account(), NOW)).toBe(true);
    expect(remainingCapacity(account())).toBe(0);

    expect(isCapacityExhausted(account({ block_requests: BLOCK_REQUESTS }), NOW)).toBe(false);
    expect(remainingCapacity(account({ block_requests: BLOCK_REQUESTS }))).toBe(BLOCK_REQUESTS);

    expect(isCapacityExhausted(account({ credit_requests: 10 }), NOW)).toBe(false);
    expect(remainingCapacity(account({ credit_requests: 10 }))).toBe(10);

    const overage = account({
      overage_active: true,
      overage_max: 50,
      overage_used: 20,
      overage_period_start: PERIOD_START,
    });
    expect(isCapacityExhausted(overage, NOW)).toBe(false);
    expect(remainingCapacity(overage)).toBe(30);
    expect(isCapacityExhausted({ ...overage, overage_used: 50 }, NOW)).toBe(true);
  });

  it("never reports an ended period as exhausted", () => {
    expect(isCapacityExhausted(account({ period_end: "2026-10-27T11:00:00Z" }), NOW)).toBe(false);
    expect(isCapacityExhausted(account({ period_end: null }), NOW)).toBe(false);
    expect(isCapacityExhausted(null, NOW)).toBe(false);
  });

  it("adds every source together for what is left", () => {
    expect(
      remainingCapacity(
        account({
          requests_used: 90_000,
          block_requests: BLOCK_REQUESTS,
          credit_requests: 1_000,
          overage_active: true,
          overage_max: BLOCK_REQUESTS,
        })
      )
    ).toBe(35_000 + 1_000 + BLOCK_REQUESTS);
  });
});

describe("parseRequestAmount", () => {
  it("reads typed request amounts as whole blocks", () => {
    expect(parseRequestAmount("75000")).toEqual({ blocks: 3, adjusted: false });
    expect(parseRequestAmount("1,250,000")).toEqual({ blocks: 50, adjusted: false });
    expect(parseRequestAmount(" 500 000 ")).toEqual({ blocks: 20, adjusted: false });
  });

  it("rounds a partial block up and says so", () => {
    expect(parseRequestAmount("60000")).toEqual({ blocks: 3, adjusted: true });
    expect(parseRequestAmount("1")).toEqual({ blocks: 1, adjusted: true });
  });

  it("keeps the amount within the allowed range", () => {
    expect(parseRequestAmount("0", { minBlocks: 1 })).toEqual({ blocks: 1, adjusted: true });
    expect(parseRequestAmount("0")).toEqual({ blocks: 0, adjusted: false });
    expect(parseRequestAmount("99999999")).toEqual({ blocks: MAX_BLOCKS, adjusted: true });
  });

  it("refuses text that is not a number", () => {
    expect(parseRequestAmount("")).toBeNull();
    expect(parseRequestAmount("lots")).toBeNull();
    expect(parseRequestAmount("-25000")).toBeNull();
    expect(parseRequestAmount("2.5e4")).toBeNull();
  });
});
