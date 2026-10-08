import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRateLimitByKeyWithInfo,
  checkRateLimitWithInfo,
  rateLimitIpBucket,
} from "./rate-limit";

// No REDIS_URL in the unit suite, so these run against the in-memory fallback.

function requestFrom(ip: string): Request {
  return new Request("https://webhooks.cc/api/test", { headers: { "cf-connecting-ip": ip } });
}

describe("rateLimitIpBucket", () => {
  it("keeps IPv4 addresses as they are", () => {
    expect(rateLimitIpBucket("203.0.113.7")).toBe("203.0.113.7");
  });

  it("counts IPv6 addresses by their /64", () => {
    expect(rateLimitIpBucket("2001:db8:1:2:aaaa::1")).toBe("2001:0db8:0001:0002::/64");
    expect(rateLimitIpBucket("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:0db8:0001:0002::/64");
    expect(rateLimitIpBucket("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(rateLimitIpBucket("::1")).toBe("0000:0000:0000:0000::/64");
    expect(rateLimitIpBucket("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
  });

  it("counts IPv4-mapped IPv6 addresses as IPv4", () => {
    expect(rateLimitIpBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("leaves anything that is not an IP alone", () => {
    expect(rateLimitIpBucket("unknown")).toBe("unknown");
  });
});

describe("rate limit buckets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts each scope on its own for the same IP", async () => {
    const request = requestFrom("198.51.100.1");
    expect((await checkRateLimitWithInfo(request, "scope-a", 1)).allowed).toBe(true);
    expect((await checkRateLimitWithInfo(request, "scope-a", 1)).allowed).toBe(false);
    expect((await checkRateLimitWithInfo(request, "scope-b", 1)).allowed).toBe(true);
  });

  it("counts addresses in one IPv6 /64 together", async () => {
    expect((await checkRateLimitWithInfo(requestFrom("2001:db8:5:6::1"), "v6", 1)).allowed).toBe(
      true
    );
    expect((await checkRateLimitWithInfo(requestFrom("2001:db8:5:6::2"), "v6", 1)).allowed).toBe(
      false
    );
    expect((await checkRateLimitWithInfo(requestFrom("2001:db8:5:7::1"), "v6", 1)).allowed).toBe(
      true
    );
  });

  it("keeps an hourly limit's history when a shorter window checks the same key", async () => {
    const key = "shared-key";
    const hour = 60 * 60_000;
    expect((await checkRateLimitByKeyWithInfo(key, 2, hour)).allowed).toBe(true);
    expect((await checkRateLimitByKeyWithInfo(key, 2, hour)).allowed).toBe(true);

    vi.advanceTimersByTime(2 * 60_000);
    // A one-minute limit on the same key used to trim the shared history to a minute.
    expect((await checkRateLimitByKeyWithInfo(key, 100, 60_000)).allowed).toBe(true);
    expect((await checkRateLimitByKeyWithInfo(key, 2, hour)).allowed).toBe(false);
  });

  it("cleans each bucket by its own window", async () => {
    const hour = 60 * 60_000;
    expect((await checkRateLimitByKeyWithInfo("cleanup-hourly", 1, hour)).allowed).toBe(true);
    vi.advanceTimersByTime(5 * 60_000);
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    // This call runs the cleanup with a one-minute window.
    await checkRateLimitByKeyWithInfo("cleanup-minute", 10, 60_000);
    random.mockRestore();
    expect((await checkRateLimitByKeyWithInfo("cleanup-hourly", 1, hour)).allowed).toBe(false);
  });
});
