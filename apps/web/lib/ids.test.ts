import { describe, expect, it } from "vitest";
import { alphanumericToken, endpointSlug, randomBase64Url, userCodePart } from "./ids";

describe("ids", () => {
  it("keep each format", () => {
    expect(alphanumericToken(32)).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(alphanumericToken(48)).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(endpointSlug()).toMatch(/^[0-9a-z]{10}$/);
    expect(userCodePart()).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
    expect(randomBase64Url(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomBase64Url(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("do not repeat", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => alphanumericToken(32)));
    expect(seen.size).toBe(1000);
  });
});
