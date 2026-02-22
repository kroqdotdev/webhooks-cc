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

describe("GET /api/search/requests", () => {
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

  test("forwards free plan for dashboard JWT requests to receiver search", async () => {
    mockFns.extractBearerToken.mockReturnValue("jwt-token");
    mockFns.convexQuery.mockResolvedValue({
      _id: "user_free_123",
      plan: "free",
    });

    const upstreamPayload = [{ id: "req_1" }];
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(upstreamPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("./route");
    const request = new Request(
      "https://webhooks.cc/api/search/requests?slug=demo&method=POST&limit=25&foo=ignored"
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(upstreamPayload);

    expect(mockFns.convexSetAuth).toHaveBeenCalledWith("jwt-token");
    expect(mockFns.validateApiKeyWithPlan).not.toHaveBeenCalled();
    expect(mockFns.convexQuery).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as unknown as [
      string | URL | Request,
      RequestInit,
    ];
    const proxiedUrl = new URL(String(url));

    expect(proxiedUrl.origin).toBe("https://go.webhooks.cc");
    expect(proxiedUrl.pathname).toBe("/search");
    expect(proxiedUrl.searchParams.get("user_id")).toBe("user_free_123");
    expect(proxiedUrl.searchParams.get("plan")).toBe("free");
    expect(proxiedUrl.searchParams.get("slug")).toBe("demo");
    expect(proxiedUrl.searchParams.get("method")).toBe("POST");
    expect(proxiedUrl.searchParams.get("limit")).toBe("25");
    expect(proxiedUrl.searchParams.get("foo")).toBeNull();

    expect(options).toMatchObject({
      headers: {
        Authorization: "Bearer shared-secret",
      },
    });
  });

  test("forwards free plan for API key requests to receiver search", async () => {
    mockFns.extractBearerToken.mockReturnValue("whcc_test_api_key");
    mockFns.validateApiKeyWithPlan.mockResolvedValue({
      userId: "user_api_123",
      plan: "free",
    });

    const upstreamPayload = [{ id: "req_2" }];
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(upstreamPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("./route");
    const request = new Request(
      "https://webhooks.cc/api/search/requests?slug=demo-api&order=asc&offset=5"
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(upstreamPayload);

    expect(mockFns.validateApiKeyWithPlan).toHaveBeenCalledWith("whcc_test_api_key");
    expect(mockFns.convexSetAuth).not.toHaveBeenCalled();
    expect(mockFns.convexQuery).not.toHaveBeenCalled();

    const [url, options] = fetchMock.mock.calls[0] as unknown as [
      string | URL | Request,
      RequestInit,
    ];
    const proxiedUrl = new URL(String(url));

    expect(proxiedUrl.origin).toBe("https://go.webhooks.cc");
    expect(proxiedUrl.pathname).toBe("/search");
    expect(proxiedUrl.searchParams.get("user_id")).toBe("user_api_123");
    expect(proxiedUrl.searchParams.get("plan")).toBe("free");
    expect(proxiedUrl.searchParams.get("slug")).toBe("demo-api");
    expect(proxiedUrl.searchParams.get("order")).toBe("asc");
    expect(proxiedUrl.searchParams.get("offset")).toBe("5");

    expect(options).toMatchObject({
      headers: {
        Authorization: "Bearer shared-secret",
      },
    });
  });

  test("returns 401 for invalid API key", async () => {
    mockFns.extractBearerToken.mockReturnValue("whcc_bad_key");
    mockFns.validateApiKeyWithPlan.mockResolvedValue(null);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid API key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 401 for dashboard JWT when Convex user is missing", async () => {
    mockFns.extractBearerToken.mockReturnValue("jwt-token");
    mockFns.convexQuery.mockResolvedValue(null);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 502 when receiver search returns 5xx", async () => {
    mockFns.extractBearerToken.mockReturnValue("whcc_test_api_key");
    mockFns.validateApiKeyWithPlan.mockResolvedValue({
      userId: "user_api_500",
      plan: "free",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 503, statusText: "Service Unavailable" }))
    );

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests?limit=10"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Search request failed" });
  });

  test("forwards pro plan to receiver search", async () => {
    mockFns.extractBearerToken.mockReturnValue("whcc_pro_key");
    mockFns.validateApiKeyWithPlan.mockResolvedValue({
      userId: "user_pro_123",
      plan: "pro",
    });

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests"));

    expect(response.status).toBe(200);

    const [url] = fetchMock.mock.calls[0] as unknown as [string | URL | Request, RequestInit];
    const proxiedUrl = new URL(String(url));
    expect(proxiedUrl.searchParams.get("plan")).toBe("pro");
  });

  test("omits plan param when plan is undefined", async () => {
    mockFns.extractBearerToken.mockReturnValue("whcc_unknown_plan");
    mockFns.validateApiKeyWithPlan.mockResolvedValue({
      userId: "user_unknown_plan",
      plan: undefined,
    });

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("./route");
    const response = await GET(new Request("https://webhooks.cc/api/search/requests"));

    expect(response.status).toBe(200);

    const [url] = fetchMock.mock.calls[0] as unknown as [string | URL | Request, RequestInit];
    const proxiedUrl = new URL(String(url));
    expect(proxiedUrl.searchParams.has("plan")).toBe(false);
  });
});
