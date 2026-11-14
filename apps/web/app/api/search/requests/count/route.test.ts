import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  countBearerRead: vi.fn(),
  extractBearerToken: vi.fn(),
  validateBearerTokenWithPlan: vi.fn(),
  checkRateLimitByKeyWithInfo: vi.fn(),
  countSearchRequests: vi.fn(),
  captureServerEvent: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  countBearerRead: mockFns.countBearerRead,
  extractBearerToken: mockFns.extractBearerToken,
  validateBearerTokenWithPlan: mockFns.validateBearerTokenWithPlan,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitByKeyWithInfo: mockFns.checkRateLimitByKeyWithInfo,
  applyRateLimitHeaders: (res: Response) => res,
}));

vi.mock("@/lib/supabase/search", () => {
  class InvalidSearchCursorError extends Error {}
  return {
    InvalidSearchCursorError,
    isRequestKind: (value: unknown) => value === "http" || value === "email",
    countSearchRequests: mockFns.countSearchRequests,
  };
});

vi.mock("@/lib/analytics-server", () => ({
  captureServerEvent: mockFns.captureServerEvent,
}));

describe("GET /api/search/requests/count", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFns.checkRateLimitByKeyWithInfo.mockResolvedValue({
      allowed: true,
      response: null,
      limit: 120,
      remaining: 119,
      reset: 0,
    });
  });

  test("returns a retained search count for a validated bearer token", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({
      userId: "user_123",
      plan: "pro",
    });
    mockFns.countSearchRequests.mockResolvedValue({
      count: 42,
      exact: true,
      searchedUntil: null,
      cursor: null,
      slices: 0,
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://webhooks.cc/api/search/requests/count?slug=demo&method=POST&q=foo")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      count: 42,
      exact: true,
      searchedUntil: null,
      cursor: null,
    });
    expect(mockFns.countBearerRead).toHaveBeenCalledWith(expect.any(Request), expect.any(String), {
      userId: "user_123",
      plan: "pro",
    });
    expect(mockFns.countSearchRequests).toHaveBeenCalledWith({
      userId: "user_123",
      plan: "pro",
      slug: "demo",
      method: "POST",
      q: "foo",
      kind: undefined,
      from: undefined,
      to: undefined,
      cursor: undefined,
    });
  });

  test("says when the count is a lower bound, and where it stopped", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({ userId: "user_123", plan: "pro" });
    mockFns.countSearchRequests.mockResolvedValue({
      count: 17,
      exact: false,
      searchedUntil: 1_700_000_000_000,
      cursor: "next_1",
      slices: 12,
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://webhooks.cc/api/search/requests/count?slug=demo&q=rare")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      count: 17,
      exact: false,
      searchedUntil: 1_700_000_000_000,
      cursor: "next_1",
    });
    expect(response.headers.get("X-Search-Complete")).toBe("false");
  });

  test("returns 401 for invalid bearer tokens", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue(null);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests/count"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid token" });
    expect(mockFns.countBearerRead).not.toHaveBeenCalled();
  });

  test("returns 400 for invalid numeric params", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({
      userId: "user_123",
      plan: "free",
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://webhooks.cc/api/search/requests/count?from=oops")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_from" });
    expect(mockFns.countSearchRequests).not.toHaveBeenCalled();
  });
});
