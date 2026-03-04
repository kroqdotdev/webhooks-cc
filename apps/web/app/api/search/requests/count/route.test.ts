import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  extractBearerToken: vi.fn(),
  validateApiKeyWithPlan: vi.fn(),
  publicEnv: vi.fn(),
  serverEnv: vi.fn(),
  checkRateLimitByKey: vi.fn(),
  convexSetAuth: vi.fn(),
  convexQuery: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  extractBearerToken: mockFns.extractBearerToken,
  validateApiKeyWithPlan: mockFns.validateApiKeyWithPlan,
}));

vi.mock("@/lib/env", () => ({
  publicEnv: mockFns.publicEnv,
  serverEnv: mockFns.serverEnv,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitByKey: mockFns.checkRateLimitByKey,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class MockConvexHttpClient {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_url: string) {}

    setAuth(token: string) {
      mockFns.convexSetAuth(token);
    }

    query(ref: unknown) {
      return mockFns.convexQuery(ref);
    }
  },
}));

vi.mock("@convex/_generated/api", () => ({
  api: {
    users: {
      current: { _mock: "users.current" },
    },
  },
}));

describe("GET /api/search/requests/count", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockFns.publicEnv.mockReturnValue({
      NEXT_PUBLIC_CONVEX_URL: "https://convex-public.example",
      NEXT_PUBLIC_WEBHOOK_URL: "https://go.webhooks.cc",
      NEXT_PUBLIC_APP_URL: "https://webhooks.cc",
    });
    mockFns.serverEnv.mockReturnValue({
      CONVEX_SITE_URL: "https://convex-site.example",
      CAPTURE_SHARED_SECRET: "shared-secret",
    });
    mockFns.checkRateLimitByKey.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("forwards free plan for dashboard JWT requests to receiver count endpoint", async () => {
    mockFns.extractBearerToken.mockReturnValue("jwt-token");
    mockFns.convexQuery.mockResolvedValue({
      _id: "user_free_123",
      plan: "free",
    });

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ count: 42 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://webhooks.cc/api/search/requests/count?slug=demo&method=POST")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ count: 42 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string | URL | Request, RequestInit];
    const proxiedUrl = new URL(String(url));
    expect(proxiedUrl.pathname).toBe("/search/count");
    expect(proxiedUrl.searchParams.get("user_id")).toBe("user_free_123");
    expect(proxiedUrl.searchParams.get("plan")).toBe("free");
    expect(proxiedUrl.searchParams.get("slug")).toBe("demo");
    expect(proxiedUrl.searchParams.get("method")).toBe("POST");
  });

  test("forwards API key requests to receiver count endpoint", async () => {
    mockFns.extractBearerToken.mockReturnValue("whcc_test_api_key");
    mockFns.validateApiKeyWithPlan.mockResolvedValue({
      userId: "user_api_123",
      plan: "pro",
    });

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ count: 7 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://webhooks.cc/api/search/requests/count?slug=demo-api")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ count: 7 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string | URL | Request, RequestInit];
    const proxiedUrl = new URL(String(url));
    expect(proxiedUrl.pathname).toBe("/search/count");
    expect(proxiedUrl.searchParams.get("user_id")).toBe("user_api_123");
    expect(proxiedUrl.searchParams.get("plan")).toBe("pro");
  });

  test("returns 401 for invalid API key", async () => {
    mockFns.extractBearerToken.mockReturnValue("whcc_bad_key");
    mockFns.validateApiKeyWithPlan.mockResolvedValue(null);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests/count"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid API key" });
  });

  test("returns 502 when receiver count response shape is invalid", async () => {
    mockFns.extractBearerToken.mockReturnValue("whcc_test_api_key");
    mockFns.validateApiKeyWithPlan.mockResolvedValue({
      userId: "user_api_123",
      plan: "free",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests/count"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Unexpected response format" });
  });
});

