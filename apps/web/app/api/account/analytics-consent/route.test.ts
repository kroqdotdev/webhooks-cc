import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateSessionRequest: vi.fn(),
  checkRateLimitByKeyWithInfo: vi.fn(),
  getAccountAnalyticsConsent: vi.fn(),
  setAccountAnalyticsConsent: vi.fn(),
  auditUserAction: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: mocks.authenticateSessionRequest,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitByKeyWithInfo: mocks.checkRateLimitByKeyWithInfo,
  applyRateLimitHeaders: (response: Response) => response,
}));

vi.mock("@/lib/audit", () => ({ auditUserAction: mocks.auditUserAction }));
vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }));

vi.mock("@/lib/supabase/analytics-consent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/analytics-consent")>();
  return {
    ...actual,
    getAccountAnalyticsConsent: mocks.getAccountAnalyticsConsent,
    setAccountAnalyticsConsent: mocks.setAccountAnalyticsConsent,
  };
});

const URL = "https://webhooks.cc/api/account/analytics-consent";

function putRequest(body: unknown) {
  return new Request(URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/api/account/analytics-consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user_1" });
    mocks.checkRateLimitByKeyWithInfo.mockResolvedValue({ allowed: true });
    mocks.setAccountAnalyticsConsent.mockResolvedValue(true);
  });

  test("GET returns the saved choice", async () => {
    mocks.getAccountAnalyticsConsent.mockResolvedValue("denied");
    const { GET } = await import("./route");
    const response = await GET(new Request(URL));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ consent: "denied" });
    expect(mocks.getAccountAnalyticsConsent).toHaveBeenCalledWith("user_1");
  });

  test("GET returns null when nothing was saved", async () => {
    mocks.getAccountAnalyticsConsent.mockResolvedValue(null);
    const { GET } = await import("./route");
    await expect((await GET(new Request(URL))).json()).resolves.toEqual({ consent: null });
  });

  test("refuses without a session", async () => {
    mocks.authenticateSessionRequest.mockResolvedValue({
      success: false,
      response: new Response(null, { status: 403 }),
    });
    const { GET, PUT } = await import("./route");
    expect((await GET(new Request(URL))).status).toBe(403);
    expect((await PUT(putRequest({ consent: "granted" }))).status).toBe(403);
    expect(mocks.setAccountAnalyticsConsent).not.toHaveBeenCalled();
  });

  test("PUT saves the choice and audits a change", async () => {
    const { PUT } = await import("./route");
    const response = await PUT(putRequest({ consent: "granted" }));
    expect(response.status).toBe(200);
    expect(mocks.setAccountAnalyticsConsent).toHaveBeenCalledWith("user_1", "granted");
    expect(mocks.auditUserAction).toHaveBeenCalledWith(
      expect.any(Request),
      "user_1",
      expect.objectContaining({
        action: "account.analytics_consent_updated",
        status: 200,
        metadata: { consent: "granted" },
      })
    );
  });

  test("PUT of the choice already saved leaves no audit row", async () => {
    mocks.setAccountAnalyticsConsent.mockResolvedValue(false);
    const { PUT } = await import("./route");
    expect((await PUT(putRequest({ consent: "denied" }))).status).toBe(200);
    expect(mocks.auditUserAction).not.toHaveBeenCalled();
  });

  test.each([{}, { consent: "pending" }, { consent: true }, [], "nope"])(
    "PUT refuses %j",
    async (body) => {
      const { PUT } = await import("./route");
      expect((await PUT(putRequest(body))).status).toBe(400);
      expect(mocks.setAccountAnalyticsConsent).not.toHaveBeenCalled();
    }
  );

  test("PUT answers 500 and reports when the save fails", async () => {
    mocks.setAccountAnalyticsConsent.mockRejectedValue(new Error("db down"));
    const { PUT } = await import("./route");
    expect((await PUT(putRequest({ consent: "granted" }))).status).toBe(500);
    expect(mocks.reportError).toHaveBeenCalled();
  });
});
