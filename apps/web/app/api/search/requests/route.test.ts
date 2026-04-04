import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  extractBearerToken: vi.fn(),
  validateBearerTokenWithPlan: vi.fn(),
  checkRateLimitByKeyWithInfo: vi.fn(),
  searchRequestsForUser: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  extractBearerToken: mockFns.extractBearerToken,
  validateBearerTokenWithPlan: mockFns.validateBearerTokenWithPlan,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitByKeyWithInfo: mockFns.checkRateLimitByKeyWithInfo,
  applyRateLimitHeaders: (res: Response) => res,
}));

vi.mock("@/lib/supabase/search", () => ({
  searchRequestsForUser: mockFns.searchRequestsForUser,
}));

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
    mockFns.searchRequestsForUser.mockResolvedValue([
      {
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
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "https://webhooks.cc/api/search/requests?slug=demo&method=POST&q=foo&from=100&to=200&limit=25&offset=5&order=asc"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
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
      },
    ]);

    expect(mockFns.searchRequestsForUser).toHaveBeenCalledWith({
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
    });
  });

  test("returns 401 when the bearer token is invalid", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue(null);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid token" });
    expect(mockFns.searchRequestsForUser).not.toHaveBeenCalled();
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
    expect(mockFns.searchRequestsForUser).not.toHaveBeenCalled();
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
    expect(mockFns.searchRequestsForUser).not.toHaveBeenCalled();
  });
});
