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
