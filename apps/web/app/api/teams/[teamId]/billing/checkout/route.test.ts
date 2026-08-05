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
    createTeamCheckout: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: mocks.authenticateSessionRequest,
}));

vi.mock("@/lib/supabase/team-billing", () => ({
  TeamBillingError: mocks.TeamBillingError,
  createTeamCheckout: mocks.createTeamCheckout,
}));

const params = { params: Promise.resolve({ teamId: "team_123" }) };

function checkoutRequest(body: unknown) {
  return new Request("https://webhooks.cc/api/teams/team_123/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/teams/[teamId]/billing/checkout", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user_123" });
    mocks.createTeamCheckout.mockResolvedValue("https://polar.sh/checkout/abc");
  });

  test("returns the auth failure response without touching billing", async () => {
    mocks.authenticateSessionRequest.mockResolvedValue({
      success: false,
      response: new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
      }),
    });

    const { POST } = await import("./route");
    const response = await POST(checkoutRequest({ seats: 3 }), params);

    expect(response.status).toBe(401);
    expect(mocks.createTeamCheckout).not.toHaveBeenCalled();
  });

  test("returns the checkout url on success", async () => {
    const { POST } = await import("./route");
    const response = await POST(checkoutRequest({ seats: 3 }), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "https://polar.sh/checkout/abc" });
    expect(mocks.createTeamCheckout).toHaveBeenCalledWith("user_123", "team_123", 3);
  });

  test("maps invalid_seats to 400 for a zero seat count", async () => {
    mocks.createTeamCheckout.mockRejectedValue(
      new mocks.TeamBillingError("invalid_seats", "Seats must be between 1 and 1000")
    );

    const { POST } = await import("./route");
    const response = await POST(checkoutRequest({ seats: 0 }), params);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Seats must be between 1 and 1000",
    });
    expect(mocks.createTeamCheckout).toHaveBeenCalledWith("user_123", "team_123", 0);
  });

  test("forwards a non-numeric seat count as NaN for the library to reject", async () => {
    mocks.createTeamCheckout.mockRejectedValue(new mocks.TeamBillingError("invalid_seats"));

    const { POST } = await import("./route");
    const response = await POST(checkoutRequest({ seats: "3" }), params);

    expect(response.status).toBe(400);
    expect(mocks.createTeamCheckout).toHaveBeenCalledWith("user_123", "team_123", NaN);
  });

  test("maps not_owner to 403", async () => {
    mocks.createTeamCheckout.mockRejectedValue(
      new mocks.TeamBillingError("not_owner", "Only the team owner can manage billing")
    );

    const { POST } = await import("./route");
    const response = await POST(checkoutRequest({ seats: 3 }), params);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the team owner can manage billing",
    });
  });

  test("maps already_subscribed to 409", async () => {
    mocks.createTeamCheckout.mockRejectedValue(
      new mocks.TeamBillingError("already_subscribed", "Team already has an active subscription")
    );

    const { POST } = await import("./route");
    const response = await POST(checkoutRequest({ seats: 3 }), params);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Team already has an active subscription",
    });
  });

  test("maps an unknown billing code to 400", async () => {
    mocks.createTeamCheckout.mockRejectedValue(new mocks.TeamBillingError("something_new"));

    const { POST } = await import("./route");
    const response = await POST(checkoutRequest({ seats: 3 }), params);

    expect(response.status).toBe(400);
  });

  test("returns 502 when Polar fails unexpectedly", async () => {
    mocks.createTeamCheckout.mockRejectedValue(new Error("polar exploded"));

    const { POST } = await import("./route");
    const response = await POST(checkoutRequest({ seats: 3 }), params);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Failed to start checkout" });
  });

  test("returns 500 when Polar is not configured", async () => {
    const { PolarConfigError } = await import("@/lib/polar");
    mocks.createTeamCheckout.mockRejectedValue(
      new PolarConfigError("POLAR_TEAMS_PRODUCT_ID is not configured")
    );

    const { POST } = await import("./route");
    const response = await POST(checkoutRequest({ seats: 3 }), params);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Billing is not configured" });
  });
});
