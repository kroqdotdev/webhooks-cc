import { describe, expect, it } from "vitest";
import { isQuotaExhausted } from "./quota";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const future = "2026-09-29T18:00:00Z";
const past = "2026-09-29T06:00:00Z";

describe("isQuotaExhausted", () => {
  it("is true when the limit is used up inside an open period", () => {
    expect(
      isQuotaExhausted({ requests_used: 50, request_limit: 50, period_end: future }, NOW)
    ).toBe(true);
  });

  it("is false below the limit", () => {
    expect(
      isQuotaExhausted({ requests_used: 49, request_limit: 50, period_end: future }, NOW)
    ).toBe(false);
  });

  it("is false once the period has ended", () => {
    expect(isQuotaExhausted({ requests_used: 50, request_limit: 50, period_end: past }, NOW)).toBe(
      false
    );
  });

  it("is false before the first period starts or without a profile", () => {
    expect(isQuotaExhausted({ requests_used: 0, request_limit: 50, period_end: null }, NOW)).toBe(
      false
    );
    expect(isQuotaExhausted(null, NOW)).toBe(false);
  });
});

describe("isQuotaExhausted with extra capacity", () => {
  const base = {
    requests_used: 100,
    request_limit: 100,
    period_start: "2026-09-01T00:00:00Z",
    period_end: future,
  };

  it("counts recurring blocks as part of the allowance", () => {
    expect(isQuotaExhausted({ ...base, block_requests: 25_000 }, NOW)).toBe(false);
    expect(isQuotaExhausted({ ...base, requests_used: 25_100, block_requests: 25_000 }, NOW)).toBe(
      true
    );
  });

  it("is false while one-time blocks are left", () => {
    expect(isQuotaExhausted({ ...base, credit_requests: 1 }, NOW)).toBe(false);
    expect(isQuotaExhausted({ ...base, credit_requests: 0 }, NOW)).toBe(true);
  });

  it("is false while overage is on and below its maximum for this period", () => {
    const overage = {
      ...base,
      overage_active: true,
      overage_max: 10,
      overage_period_start: base.period_start,
    };
    expect(isQuotaExhausted({ ...overage, overage_used: 9 }, NOW)).toBe(false);
    expect(isQuotaExhausted({ ...overage, overage_used: 10 }, NOW)).toBe(true);
    // A count from an earlier period no longer applies.
    expect(
      isQuotaExhausted(
        { ...overage, overage_used: 10, overage_period_start: "2026-08-01T00:00:00Z" },
        NOW
      )
    ).toBe(false);
  });

  it("ignores overage that is switched off", () => {
    expect(isQuotaExhausted({ ...base, overage_active: false, overage_max: 10 }, NOW)).toBe(true);
  });
});
