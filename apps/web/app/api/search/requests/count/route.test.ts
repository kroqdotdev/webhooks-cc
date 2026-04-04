import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  extractBearerToken: vi.fn(),
  validateBearerTokenWithPlan: vi.fn(),
  checkRateLimitByKeyWithInfo: vi.fn(),
  countSearchRequestsForUser: vi.fn(),
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
  countSearchRequestsForUser: mockFns.countSearchRequestsForUser,
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
    mockFns.countSearchRequestsForUser.mockResolvedValue(42);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://webhooks.cc/api/search/requests/count?slug=demo&method=POST&q=foo")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ count: 42 });
    expect(mockFns.countSearchRequestsForUser).toHaveBeenCalledWith({
      userId: "user_123",
      plan: "pro",
      slug: "demo",
      method: "POST",
      q: "foo",
      from: undefined,
      to: undefined,
    });
  });

  test("returns 401 for invalid bearer tokens", async () => {
    mockFns.extractBearerToken.mockReturnValue("token");
    mockFns.validateBearerTokenWithPlan.mockResolvedValue(null);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests/count"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid token" });
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
    expect(mockFns.countSearchRequestsForUser).not.toHaveBeenCalled();
  });
});
