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
    resubscribeTeam: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: mocks.authenticateSessionRequest,
}));

vi.mock("@/lib/supabase/team-billing", () => ({
  TeamBillingError: mocks.TeamBillingError,
  resubscribeTeam: mocks.resubscribeTeam,
}));

const params = { params: Promise.resolve({ teamId: "team_123" }) };

function resubscribeRequest() {
  return new Request("https://webhooks.cc/api/teams/team_123/billing/resubscribe", {
    method: "POST",
  });
}

describe("POST /api/teams/[teamId]/billing/resubscribe", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user_123" });
    mocks.resubscribeTeam.mockResolvedValue(undefined);
  });

  test("reactivates the subscription and returns 204", async () => {
    const { POST } = await import("./route");
    const response = await POST(resubscribeRequest(), params);

    expect(response.status).toBe(204);
    expect(mocks.resubscribeTeam).toHaveBeenCalledWith("user_123", "team_123");
  });

  test("maps not_scheduled to 409", async () => {
    mocks.resubscribeTeam.mockRejectedValue(
      new mocks.TeamBillingError("not_scheduled", "Subscription is not scheduled for cancellation")
    );

    const { POST } = await import("./route");
    const response = await POST(resubscribeRequest(), params);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Subscription is not scheduled for cancellation",
    });
  });
});
