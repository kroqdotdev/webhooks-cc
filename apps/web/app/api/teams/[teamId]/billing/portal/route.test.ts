import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class TeamBillingError extends Error {
    code: string;

    constructor(code: string, message?: string) {
      super(message ?? code);
      this.name = "TeamBillingError";
      this.code = code;
    }
  }

  return {
    TeamBillingError,
    authenticateSessionRequest: vi.fn(),
    createTeamCustomerPortal: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: mocks.authenticateSessionRequest,
}));

vi.mock("@/lib/supabase/team-billing", () => ({
  TeamBillingError: mocks.TeamBillingError,
  createTeamCustomerPortal: mocks.createTeamCustomerPortal,
}));

const params = { params: Promise.resolve({ teamId: "team_123" }) };

function portalRequest() {
  return new Request("https://webhooks.cc/api/teams/team_123/billing/portal", { method: "POST" });
}

describe("POST /api/teams/[teamId]/billing/portal", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user_123" });
    mocks.createTeamCustomerPortal.mockResolvedValue("https://polar.test/portal");
  });

  test("answers the portal link for the owner", async () => {
    const { POST } = await import("./route");
    const response = await POST(portalRequest(), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "https://polar.test/portal" });
    expect(mocks.createTeamCustomerPortal).toHaveBeenCalledWith("user_123", "team_123");
  });

  test("refuses whoever has no session, an API key included", async () => {
    mocks.authenticateSessionRequest.mockResolvedValue({
      success: false,
      response: Response.json({ error: "A signed-in session is required" }, { status: 403 }),
    });

    const { POST } = await import("./route");
    const response = await POST(portalRequest(), params);

    expect(response.status).toBe(403);
    expect(mocks.createTeamCustomerPortal).not.toHaveBeenCalled();
  });

  test("maps not_owner to 403 and no_customer to 409", async () => {
    const { POST } = await import("./route");

    mocks.createTeamCustomerPortal.mockRejectedValueOnce(
      new mocks.TeamBillingError("not_owner", "Only the team owner can manage billing")
    );
    expect((await POST(portalRequest(), params)).status).toBe(403);

    mocks.createTeamCustomerPortal.mockRejectedValueOnce(
      new mocks.TeamBillingError("no_customer", "This team has no invoices yet")
    );
    const response = await POST(portalRequest(), params);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "This team has no invoices yet" });
  });
});
