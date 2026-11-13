import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequestRequireUser: vi.fn(),
  getBillingSummary: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateRequestRequireUser: mocks.authenticateRequestRequireUser,
}));
vi.mock("@/lib/billing/summary", () => ({ getBillingSummary: mocks.getBillingSummary }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

import { GET } from "./route";

const request = () => new Request("https://webhooks.cc/api/billing");

describe("GET /api/billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue(null);
  });

  it("answers an API key with the account's summary", async () => {
    mocks.authenticateRequestRequireUser.mockResolvedValue({
      success: true,
      userId: "user-1",
      keyId: "key-1",
    });
    mocks.getBillingSummary.mockResolvedValue({ plan: "pro" });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan: "pro" });
    expect(mocks.getBillingSummary).toHaveBeenCalledWith("user-1");
  });

  it("passes on a refused bearer and answers 404 for a missing account", async () => {
    mocks.authenticateRequestRequireUser.mockResolvedValueOnce({
      success: false,
      response: Response.json({ error: "Invalid token" }, { status: 401 }),
    });
    expect((await GET(request())).status).toBe(401);
    mocks.authenticateRequestRequireUser.mockResolvedValue({ success: true, userId: "gone" });
    mocks.getBillingSummary.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(404);
  });
});
