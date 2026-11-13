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
    auditUserAction: vi.fn(),
    changeTeamPlan: vi.fn(),
    keepTeamPlan: vi.fn(),
    quoteTeamPlanChange: vi.fn(),
  };
});

// The GET (a quote) takes any key of the account; the POST a session. Both
// resolve the same way here.
vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: mocks.authenticateSessionRequest,
  authenticateRequestRequireUser: mocks.authenticateSessionRequest,
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => null }));

vi.mock("@/lib/audit", () => ({ auditUserAction: mocks.auditUserAction }));

vi.mock("@/lib/supabase/team-billing", () => ({
  TeamBillingError: mocks.TeamBillingError,
  changeTeamPlan: mocks.changeTeamPlan,
  keepTeamPlan: mocks.keepTeamPlan,
  quoteTeamPlanChange: mocks.quoteTeamPlanChange,
}));

const params = { params: Promise.resolve({ teamId: "team_123" }) };
const URL_BASE = "https://webhooks.cc/api/teams/team_123/billing/plan";

function post(body: unknown) {
  return new Request(URL_BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/teams/[teamId]/billing/plan", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user_123" });
    mocks.changeTeamPlan.mockResolvedValue({ applied: "now" });
  });

  test("changes the plan and audits it", async () => {
    const { POST } = await import("./route");
    const response = await POST(post({ plan: "team_business", interval: "year" }), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ applied: "now" });
    expect(mocks.changeTeamPlan).toHaveBeenCalledWith(
      "user_123",
      "team_123",
      "team_business",
      "year"
    );
    expect(mocks.auditUserAction).toHaveBeenCalledWith(
      expect.anything(),
      "user_123",
      expect.objectContaining({
        action: "team.plan_changed",
        status: 200,
        metadata: { plan: "team_business", interval: "year", applied: "now" },
      })
    );
  });

  test("keeps the plan with action keep", async () => {
    const { POST } = await import("./route");
    const response = await POST(post({ action: "keep" }), params);

    expect(response.status).toBe(204);
    expect(mocks.keepTeamPlan).toHaveBeenCalledWith("user_123", "team_123");
    expect(mocks.changeTeamPlan).not.toHaveBeenCalled();
  });

  test("refuses an unknown plan without touching billing", async () => {
    const { POST } = await import("./route");
    const response = await POST(post({ plan: "enterprise" }), params);

    expect(response.status).toBe(400);
    expect(mocks.changeTeamPlan).not.toHaveBeenCalled();
  });

  test("maps a declined card to 402 and the seat minimum to 409", async () => {
    const { POST } = await import("./route");
    mocks.changeTeamPlan.mockRejectedValueOnce(
      new mocks.TeamBillingError("payment_failed", "declined")
    );
    expect((await POST(post({ plan: "team_business" }), params)).status).toBe(402);

    mocks.changeTeamPlan.mockRejectedValueOnce(
      new mocks.TeamBillingError("seats_below_minimum", "add a seat")
    );
    const response = await POST(post({ plan: "team_business" }), params);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "add a seat" });
  });

  test("quotes a change", async () => {
    mocks.quoteTeamPlanChange.mockResolvedValue({ dueNowCents: 4600 });
    const { GET } = await import("./route");
    const response = await GET(
      new Request(`${URL_BASE}?plan=team_business&interval=month`),
      params
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ dueNowCents: 4600 });
    expect(mocks.quoteTeamPlanChange).toHaveBeenCalledWith(
      "user_123",
      "team_123",
      "team_business",
      "month"
    );
  });
});
