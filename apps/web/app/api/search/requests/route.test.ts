import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  countBearerRead: vi.fn(),
  extractBearerToken: vi.fn(),
  validateBearerTokenWithPlan: vi.fn(),
  checkRateLimitByKeyWithInfo: vi.fn(),
  searchRequestPage: vi.fn(),
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
    searchRequestPage: mockFns.searchRequestPage,
  };
});

vi.mock("@/lib/analytics-server", () => ({
  captureServerEvent: mockFns.captureServerEvent,
}));

const record = {
  id: "req_1",
  slug: "demo",
  method: "POST",
  path: "/hooks/demo",
  headers: { "content-type": "application/json" },
  body: '{"ok":true}',
  queryParams: { foo: "bar" },
  contentType: "application/json",
  ip: "127.0.0.1",
  size: 11,
  receivedAt: 1_234,
};

describe("GET /api/search/requests", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFns.checkRateLimitByKeyWithInfo.mockResolvedValue({
      allowed: true,
      response: null,
      limit: 60,
      remaining: 59,
      reset: 0,
    });
  });

  test("returns search results for a validated bearer token", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({
      userId: "user_123",
      plan: "free",
    });
    mockFns.searchRequestPage.mockResolvedValue({
      requests: [record],
      complete: true,
      searchedUntil: null,
      cursor: null,
      slices: 1,
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "https://webhooks.cc/api/search/requests?slug=demo&method=POST&q=foo&from=100&to=200&limit=25&offset=5&order=asc"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([record]);
    expect(response.headers.get("X-Search-Complete")).toBe("true");
    expect(response.headers.get("X-Search-Cursor")).toBeNull();

    expect(mockFns.countBearerRead).toHaveBeenCalledWith(expect.any(Request), expect.any(String), {
      userId: "user_123",
      plan: "free",
    });
    expect(mockFns.searchRequestPage).toHaveBeenCalledWith({
      userId: "user_123",
      plan: "free",
      slug: "demo",
      method: "POST",
      q: "foo",
      from: 100,
      to: 200,
      limit: 25,
      offset: 5,
      order: "asc",
      cursor: undefined,
      kind: undefined,
    });
    // Telemetry never carries the term or the slug.
    const event = mockFns.captureServerEvent.mock.calls[0][0];
    expect(event.event).toBe("request_search");
    expect(JSON.stringify(event)).not.toContain("foo");
    expect(JSON.stringify(event)).not.toContain("demo");
  });

  test("answers where an unfinished search stopped, and continues from a cursor", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({ userId: "user_123", plan: "pro" });
    mockFns.searchRequestPage.mockResolvedValue({
      requests: [],
      complete: false,
      searchedUntil: 1_700_000_000_000,
      cursor: "abc_DEF-1",
      slices: 9,
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://webhooks.cc/api/search/requests?slug=demo&q=rare&cursor=prev_CURSOR")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
    expect(response.headers.get("X-Search-Complete")).toBe("false");
    expect(response.headers.get("X-Search-Searched-Until")).toBe("1700000000000");
    expect(response.headers.get("X-Search-Cursor")).toBe("abc_DEF-1");
    expect(mockFns.searchRequestPage).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "prev_CURSOR", q: "rare" })
    );
  });

  test("reads a duration as that long before now", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({ userId: "user_123", plan: "pro" });
    mockFns.searchRequestPage.mockResolvedValue({
      requests: [],
      complete: true,
      searchedUntil: null,
      cursor: null,
      slices: 1,
    });

    const before = Date.now();
    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests?from=1h"));

    expect(response.status).toBe(200);
    const from = mockFns.searchRequestPage.mock.calls[0][0].from as number;
    expect(from).toBeGreaterThanOrEqual(before - 3_600_000);
    expect(from).toBeLessThanOrEqual(Date.now() - 3_600_000);
  });

  test("returns 400 for a cursor the server did not issue", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({ userId: "user_123", plan: "pro" });
    const { InvalidSearchCursorError } = await import("@/lib/supabase/search");
    mockFns.searchRequestPage.mockRejectedValue(new InvalidSearchCursorError());

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests?cursor=nope"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_cursor" });
  });

  test("returns 401 when the bearer token is invalid", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue(null);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid token" });
    expect(mockFns.searchRequestPage).not.toHaveBeenCalled();
    expect(mockFns.countBearerRead).not.toHaveBeenCalled();
  });

  test("returns 401 when the header is missing", async () => {
    mockFns.extractBearerToken.mockReturnValue(null);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Missing authorization header" });
  });

  test("returns a rate limit response before querying search", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({
      userId: "user_123",
      plan: "free",
    });
    mockFns.checkRateLimitByKeyWithInfo.mockResolvedValue({
      allowed: false,
      response: Response.json({ error: "Too many requests" }, { status: 429 }),
      limit: 60,
      remaining: 0,
      reset: 0,
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests"));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "Too many requests" });
    expect(mockFns.searchRequestPage).not.toHaveBeenCalled();
  });

  test("returns 400 for invalid numeric params", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({
      userId: "user_123",
      plan: "free",
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://webhooks.cc/api/search/requests?limit=not-a-number")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_limit" });
    expect(mockFns.searchRequestPage).not.toHaveBeenCalled();
  });

  test("returns 400 for a time that is neither ms nor a duration", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue({ userId: "user_123", plan: "pro" });

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests?to=yesterday"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_to" });
    expect(mockFns.searchRequestPage).not.toHaveBeenCalled();
  });
});
