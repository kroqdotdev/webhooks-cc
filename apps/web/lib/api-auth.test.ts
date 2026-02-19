import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("api-auth", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CONVEX_SITE_URL = "https://convex.example";
    process.env.CAPTURE_SHARED_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("validateApiKeyWithPlan returns user id and plan", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ userId: "user_123", plan: "free" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { validateApiKeyWithPlan } = await import("./api-auth");
    const result = await validateApiKeyWithPlan("whcc_abc123");

    expect(result).toEqual({ userId: "user_123", plan: "free" });
    expect(fetchMock).toHaveBeenCalledWith("https://convex.example/validate-api-key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({ apiKey: "whcc_abc123" }),
    });
  });

  test("validateApiKeyWithPlan ignores unknown plan values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ userId: "user_456", plan: "enterprise" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const { validateApiKeyWithPlan } = await import("./api-auth");
    const result = await validateApiKeyWithPlan("whcc_def456");

    expect(result).toEqual({ userId: "user_456", plan: undefined });
  });

  test("validateApiKey preserves legacy userId return shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ userId: "user_789", plan: "pro" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const { validateApiKey } = await import("./api-auth");
    const result = await validateApiKey("whcc_xyz789");

    expect(result).toBe("user_789");
  });
});
