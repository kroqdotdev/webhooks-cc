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
    cancelTeamSubscription: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: mocks.authenticateSessionRequest,
}));

vi.mock("@/lib/supabase/team-billing", () => ({
  TeamBillingError: mocks.TeamBillingError,
  cancelTeamSubscription: mocks.cancelTeamSubscription,
}));

const params = { params: Promise.resolve({ teamId: "team_123" }) };

function cancelRequest() {
  return new Request("https://webhooks.cc/api/teams/team_123/billing/cancel", { method: "POST" });
}

describe("POST /api/teams/[teamId]/billing/cancel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user_123" });
    mocks.cancelTeamSubscription.mockResolvedValue(undefined);
  });

  test("cancels the subscription and returns 204", async () => {
    const { POST } = await import("./route");
    const response = await POST(cancelRequest(), params);

    expect(response.status).toBe(204);
    expect(mocks.cancelTeamSubscription).toHaveBeenCalledWith("user_123", "team_123");
  });

  test("maps no_subscription to 409", async () => {
    mocks.cancelTeamSubscription.mockRejectedValue(
      new mocks.TeamBillingError("no_subscription", "No active subscription")
    );

    const { POST } = await import("./route");
    const response = await POST(cancelRequest(), params);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "No active subscription" });
  });
});
