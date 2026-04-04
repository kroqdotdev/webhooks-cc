import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RateLimitInfo } from "@/lib/rate-limit";

// Helper to dynamically import a fresh module (resets the in-memory store)
async function freshImport() {
  vi.resetModules();
  return import("@/lib/rate-limit");
}

describe("checkRateLimitByKeyWithInfo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("first request returns allowed=true with correct metadata", async () => {
    const { checkRateLimitByKeyWithInfo } = await freshImport();
    const info = await checkRateLimitByKeyWithInfo("test-key", 5, 60_000);

    expect(info.allowed).toBe(true);
    expect(info.response).toBeNull();
    expect(info.limit).toBe(5);
    expect(info.remaining).toBe(4); // max (5) - 1 used
    expect(info.reset).toBeTypeOf("number");
    // reset = earliest (now) + windowMs, as Unix seconds
    const expectedReset = Math.ceil((Date.now() + 60_000) / 1000);
    expect(info.reset).toBe(expectedReset);
  });

  test("remaining decrements with each request", async () => {
    const { checkRateLimitByKeyWithInfo } = await freshImport();

    const info1 = await checkRateLimitByKeyWithInfo("test-key", 3, 60_000);
    expect(info1.remaining).toBe(2);

    const info2 = await checkRateLimitByKeyWithInfo("test-key", 3, 60_000);
    expect(info2.remaining).toBe(1);

    const info3 = await checkRateLimitByKeyWithInfo("test-key", 3, 60_000);
    expect(info3.remaining).toBe(0);
    expect(info3.allowed).toBe(true); // still allowed (this is the 3rd of 3)
  });

  test("exceeding limit returns allowed=false with 429 response", async () => {
    const { checkRateLimitByKeyWithInfo } = await freshImport();

    // Use up all 2 allowed requests
    await checkRateLimitByKeyWithInfo("test-key", 2, 60_000);
    await checkRateLimitByKeyWithInfo("test-key", 2, 60_000);

    // Third request should be blocked
    const info = await checkRateLimitByKeyWithInfo("test-key", 2, 60_000);
    expect(info.allowed).toBe(false);
    expect(info.response).not.toBeNull();
    expect(info.response!.status).toBe(429);
    expect(info.remaining).toBe(0);
    expect(info.limit).toBe(2);
  });

  test("429 response includes X-RateLimit-* headers AND Retry-After", async () => {
    const { checkRateLimitByKeyWithInfo } = await freshImport();

    // Exhaust the limit
    await checkRateLimitByKeyWithInfo("test-key", 1, 60_000);
    const info = await checkRateLimitByKeyWithInfo("test-key", 1, 60_000);

    const response = info.response!;
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).toBeTruthy();

    const resetValue = Number(response.headers.get("X-RateLimit-Reset"));
    const expectedReset = Math.ceil((Date.now() + 60_000) / 1000);
    expect(resetValue).toBe(expectedReset);
  });

  test("Retry-After reflects remaining time, not full window", async () => {
    const { checkRateLimitByKeyWithInfo } = await freshImport();

    // Exhaust limit at t=0
    await checkRateLimitByKeyWithInfo("test-key", 1, 60_000);

    // Advance 45 seconds into the 60s window
    vi.advanceTimersByTime(45_000);

    // Hit rate limit — should get ~15s retry, not 60s
    const info = await checkRateLimitByKeyWithInfo("test-key", 1, 60_000);
    expect(info.allowed).toBe(false);
    expect(info.response!.headers.get("Retry-After")).toBe("15");
  });

  test("reset timestamp is based on earliest request in window", async () => {
    const { checkRateLimitByKeyWithInfo } = await freshImport();

    // First request at t=0
    const info1 = await checkRateLimitByKeyWithInfo("test-key", 5, 60_000);
    const firstRequestTime = Date.now();

    // Advance time by 10 seconds
    vi.advanceTimersByTime(10_000);

    // Second request at t=10s
    const info2 = await checkRateLimitByKeyWithInfo("test-key", 5, 60_000);

    // Reset should still be based on earliest timestamp (t=0) + windowMs
    const expectedReset = Math.ceil((firstRequestTime + 60_000) / 1000);
    expect(info1.reset).toBe(expectedReset);
    expect(info2.reset).toBe(expectedReset);
  });
});

describe("checkRateLimitWithInfo (IP-based)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("extracts IP from x-forwarded-for header", async () => {
    const { checkRateLimitWithInfo } = await freshImport();

    const request = new Request("https://example.com/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    });

    const info = await checkRateLimitWithInfo(request, 5, 60_000);
    expect(info.allowed).toBe(true);
    expect(info.remaining).toBe(4);

    // A request from a different IP should have its own bucket
    const request2 = new Request("https://example.com/test", {
      headers: { "x-forwarded-for": "5.6.7.8" },
    });
    const info2 = await checkRateLimitWithInfo(request2, 5, 60_000);
    expect(info2.allowed).toBe(true);
    expect(info2.remaining).toBe(4); // independent counter
  });

  test("extracts IP from x-real-ip when x-forwarded-for is absent", async () => {
    const { checkRateLimitWithInfo } = await freshImport();

    const request = new Request("https://example.com/test", {
      headers: { "x-real-ip": "9.8.7.6" },
    });

    const info = await checkRateLimitWithInfo(request, 5, 60_000);
    expect(info.allowed).toBe(true);
    expect(info.remaining).toBe(4);
  });

  test("uses 'unknown' when no IP headers are present", async () => {
    const { checkRateLimitWithInfo } = await freshImport();

    const request = new Request("https://example.com/test");
    const info = await checkRateLimitWithInfo(request, 2, 60_000);
    expect(info.allowed).toBe(true);

    // Second request from same "unknown" key
    const request2 = new Request("https://example.com/test");
    const info2 = await checkRateLimitWithInfo(request2, 2, 60_000);
    expect(info2.allowed).toBe(true);
    expect(info2.remaining).toBe(0);

    // Third request should be blocked
    const request3 = new Request("https://example.com/test");
    const info3 = await checkRateLimitWithInfo(request3, 2, 60_000);
    expect(info3.allowed).toBe(false);
  });
});

describe("backwards-compatible wrappers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("checkRateLimitByKey returns null when allowed", async () => {
    const { checkRateLimitByKey } = await freshImport();
    const result = await checkRateLimitByKey("test-key", 5, 60_000);
    expect(result).toBeNull();
  });

  test("checkRateLimitByKey returns Response when blocked", async () => {
    const { checkRateLimitByKey } = await freshImport();
    await checkRateLimitByKey("test-key", 1, 60_000);
    const result = await checkRateLimitByKey("test-key", 1, 60_000);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(429);
  });

  test("checkRateLimit returns null when allowed", async () => {
    const { checkRateLimit } = await freshImport();
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    const result = await checkRateLimit(request, 5, 60_000);
    expect(result).toBeNull();
  });

  test("checkRateLimit returns Response when blocked", async () => {
    const { checkRateLimit } = await freshImport();
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    await checkRateLimit(request, 1, 60_000);
    const result = await checkRateLimit(request, 1, 60_000);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(429);
  });
});

describe("applyRateLimitHeaders", () => {
  test("sets rate limit headers on a response", async () => {
    const { applyRateLimitHeaders } = await freshImport();

    const response = new Response("OK", { status: 200 });
    const info: RateLimitInfo = {
      allowed: true,
      response: null,
      limit: 10,
      remaining: 7,
      reset: 1735689660,
    };

    const result = applyRateLimitHeaders(response, info);
    expect(result).toBe(response); // same object returned
    expect(result.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(result.headers.get("X-RateLimit-Remaining")).toBe("7");
    expect(result.headers.get("X-RateLimit-Reset")).toBe("1735689660");
  });
});
