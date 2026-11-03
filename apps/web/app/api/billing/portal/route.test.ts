import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class BillingActionError extends Error {
    code: string;

    constructor(code: string, message?: string) {
      super(message ?? code);
      this.name = "BillingActionError";
      this.code = code;
    }
  }

  return {
    BillingActionError,
    authenticateSessionRequest: vi.fn(),
    createCustomerPortalForUser: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: mocks.authenticateSessionRequest,
}));

vi.mock("@/lib/supabase/billing", () => ({
  BillingActionError: mocks.BillingActionError,
  createCustomerPortalForUser: mocks.createCustomerPortalForUser,
}));

function portalRequest() {
  return new Request("https://webhooks.cc/api/billing/portal", { method: "POST" });
}

describe("POST /api/billing/portal", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user_123" });
    mocks.createCustomerPortalForUser.mockResolvedValue("https://polar.test/portal");
  });

  test("answers the portal link for the signed-in account", async () => {
    const { POST } = await import("./route");
    const response = await POST(portalRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "https://polar.test/portal" });
    expect(mocks.createCustomerPortalForUser).toHaveBeenCalledWith("user_123");
  });

  test("refuses whoever has no session, an API key included", async () => {
    mocks.authenticateSessionRequest.mockResolvedValue({
      success: false,
      response: Response.json({ error: "A signed-in session is required" }, { status: 403 }),
    });

    const { POST } = await import("./route");
    expect((await POST(portalRequest())).status).toBe(403);
    expect(mocks.createCustomerPortalForUser).not.toHaveBeenCalled();
  });

  test("maps an account without a Polar customer to 409", async () => {
    mocks.createCustomerPortalForUser.mockRejectedValue(
      new mocks.BillingActionError("no_customer", "This account has no invoices yet")
    );

    const { POST } = await import("./route");
    const response = await POST(portalRequest());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "This account has no invoices yet" });
  });
});
