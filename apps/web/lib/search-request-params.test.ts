import { describe, expect, test } from "vitest";
import { applySearchProgressHeaders, parseSearchTime } from "./search-request-params";

describe("parseSearchTime", () => {
  const now = 1_800_000_000_000;

  test("is undefined when absent and null when empty or invalid", () => {
    expect(parseSearchTime(null, now)).toBeUndefined();
    expect(parseSearchTime("", now)).toBeNull();
    expect(parseSearchTime("yesterday", now)).toBeNull();
    expect(parseSearchTime("-5", now)).toBeNull();
    expect(parseSearchTime("1e3", now)).toBeNull();
    expect(parseSearchTime("0x10", now)).toBeNull();
  });

  test("reads epoch milliseconds", () => {
    expect(parseSearchTime("1700000000000", now)).toBe(1_700_000_000_000);
    expect(parseSearchTime("0", now)).toBe(0);
  });

  test("reads a duration as that long before now", () => {
    expect(parseSearchTime("1h", now)).toBe(now - 3_600_000);
    expect(parseSearchTime("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseSearchTime("90s", now)).toBe(now - 90_000);
    expect(parseSearchTime("1.5h", now)).toBe(now - 5_400_000);
    expect(parseSearchTime("500ms", now)).toBe(now - 500);
    expect(parseSearchTime(" 15m ", now)).toBe(now - 900_000);
  });
});

describe("applySearchProgressHeaders", () => {
  test("sets how far the search read", () => {
    const response = applySearchProgressHeaders(Response.json([]), {
      complete: false,
      searchedUntil: 123,
      cursor: "c1",
    });
    expect(response.headers.get("X-Search-Complete")).toBe("false");
    expect(response.headers.get("X-Search-Searched-Until")).toBe("123");
    expect(response.headers.get("X-Search-Cursor")).toBe("c1");
  });

  test("leaves out what a complete search does not have", () => {
    const response = applySearchProgressHeaders(Response.json([]), {
      complete: true,
      searchedUntil: null,
      cursor: null,
    });
    expect(response.headers.get("X-Search-Complete")).toBe("true");
    expect(response.headers.has("X-Search-Searched-Until")).toBe(false);
    expect(response.headers.has("X-Search-Cursor")).toBe(false);
  });
});
