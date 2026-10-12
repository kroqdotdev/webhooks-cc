import { afterEach, beforeEach, describe as group, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock("@statoss/sdk", () => sdk);

import { admit, describe, reportError, reportRequestError, resetThrottle } from "./observability";

beforeEach(() => {
  resetThrottle();
  sdk.captureException.mockClear();
  sdk.captureMessage.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

group("admit", () => {
  it("lets one event a minute through per site and counts the rest", () => {
    expect(admit("a", 0)).toEqual({ send: true, suppressed: 0 });
    expect(admit("a", 1_000)).toEqual({ send: false, suppressed: 0 });
    expect(admit("a", 59_999)).toEqual({ send: false, suppressed: 0 });
    expect(admit("b", 1_000)).toEqual({ send: true, suppressed: 0 });
    expect(admit("a", 60_000)).toEqual({ send: true, suppressed: 2 });
    expect(admit("a", 120_000)).toEqual({ send: true, suppressed: 0 });
  });
});

group("describe", () => {
  it("reads a query error's message and code", () => {
    expect(describe({ message: "relation does not exist", code: "42P01" })).toBe(
      "relation does not exist (42P01)"
    );
  });

  it("falls back to JSON, then to String", () => {
    expect(describe({ statusCode: 502 })).toBe('{"statusCode":502}');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(describe(cycle)).toBe("[object Object]");
    expect(describe("plain")).toBe("plain");
  });
});

group("reportError", () => {
  it("logs the line as before and reports an Error grouped by its site", () => {
    const error = new Error("connection reset");
    reportError("Failed to list endpoints", error, { teamId: "t1" });
    expect(console.error).toHaveBeenCalledWith("Failed to list endpoints:", error, {
      teamId: "t1",
    });
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      level: "error",
      fingerprint: ["Failed to list endpoints"],
      tags: { where: "Failed to list endpoints" },
      extra: { teamId: "t1" },
    });
  });

  it("reports a value that is not an Error as a message with the value as detail", () => {
    const queryError = { message: "timeout", code: "57014" };
    reportError("Failed to count deliveries", queryError);
    expect(sdk.captureMessage).toHaveBeenCalledWith("Failed to count deliveries: timeout (57014)", {
      level: "error",
      fingerprint: ["Failed to count deliveries"],
      tags: { where: "Failed to count deliveries" },
      extra: { detail: queryError },
    });
  });

  it("reports a bare message", () => {
    reportError("[blog-api] BLOG_API_SECRET is not configured");
    expect(console.error).toHaveBeenCalledWith("[blog-api] BLOG_API_SECRET is not configured");
    expect(sdk.captureMessage).toHaveBeenCalledWith(
      "[blog-api] BLOG_API_SECRET is not configured",
      expect.objectContaining({ extra: {} })
    );
  });

  it("logs every time but sends once a minute, with the count held back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    for (let i = 0; i < 5; i++) reportError("[redis] connection error", new Error("ECONNREFUSED"));
    expect(console.error).toHaveBeenCalledTimes(5);
    expect(sdk.captureException).toHaveBeenCalledTimes(1);

    vi.setSystemTime(60_000);
    reportError("[redis] connection error", new Error("ECONNREFUSED"));
    expect(sdk.captureException).toHaveBeenCalledTimes(2);
    expect(sdk.captureException.mock.calls[1][1].extra).toEqual({ suppressed: 4 });
  });
});

group("reportRequestError", () => {
  it("tags the route pattern and method, never the path", () => {
    const error = Object.assign(new Error("boom"), { digest: "123" });
    reportRequestError(
      error,
      { method: "GET" },
      { routePath: "/api/stream/[slug]", routeType: "route" }
    );
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      tags: { route: "/api/stream/[slug]", routeType: "route", method: "GET", digest: "123" },
      extra: {},
    });
  });
});
