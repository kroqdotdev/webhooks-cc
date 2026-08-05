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
    updateTeamSeats: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: mocks.authenticateSessionRequest,
}));

vi.mock("@/lib/supabase/team-billing", () => ({
  TeamBillingError: mocks.TeamBillingError,
  updateTeamSeats: mocks.updateTeamSeats,
}));

const params = { params: Promise.resolve({ teamId: "team_123" }) };

function seatsRequest(body: unknown) {
  return new Request("https://webhooks.cc/api/teams/team_123/billing/seats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/teams/[teamId]/billing/seats", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user_123" });
    mocks.updateTeamSeats.mockResolvedValue(undefined);
  });

  test("returns the auth failure response without touching billing", async () => {
    mocks.authenticateSessionRequest.mockResolvedValue({
      success: false,
      response: new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
      }),
    });

    const { POST } = await import("./route");
    const response = await POST(seatsRequest({ seats: 5 }), params);

    expect(response.status).toBe(401);
    expect(mocks.updateTeamSeats).not.toHaveBeenCalled();
  });

  test("forwards the seat count and returns 204", async () => {
    const { POST } = await import("./route");
    const response = await POST(seatsRequest({ seats: 5 }), params);

    expect(response.status).toBe(204);
    expect(mocks.updateTeamSeats).toHaveBeenCalledWith("user_123", "team_123", 5);
  });

  test("maps seats_below_members to 409", async () => {
    mocks.updateTeamSeats.mockRejectedValue(
      new mocks.TeamBillingError(
        "seats_below_members",
        "Team has 4 members — remove members before reducing to 2 seats"
      )
    );

    const { POST } = await import("./route");
    const response = await POST(seatsRequest({ seats: 2 }), params);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Team has 4 members — remove members before reducing to 2 seats",
    });
  });

  test("returns 502 when Polar fails unexpectedly", async () => {
    mocks.updateTeamSeats.mockRejectedValue(new Error("polar exploded"));

    const { POST } = await import("./route");
    const response = await POST(seatsRequest({ seats: 5 }), params);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Failed to update seats" });
  });
});
