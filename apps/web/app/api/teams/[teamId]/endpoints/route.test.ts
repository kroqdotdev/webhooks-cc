import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequestRequireUser: vi.fn(),
  listTeamEndpoints: vi.fn(),
  shareEndpointWithTeam: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateRequestRequireUser: mocks.authenticateRequestRequireUser,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitByKeyWithInfo: vi.fn().mockResolvedValue({ allowed: true }),
  applyRateLimitHeaders: (response: Response) => response,
}));

vi.mock("@/lib/audit", () => ({
  auditUserAction: vi.fn(),
}));

vi.mock("@/lib/observability", () => ({
  reportError: mocks.reportError,
}));

vi.mock("@/lib/supabase/teams", () => ({
  listTeamEndpoints: mocks.listTeamEndpoints,
  shareEndpointWithTeam: mocks.shareEndpointWithTeam,
}));

const params = { params: Promise.resolve({ teamId: "team_123" }) };

function getRequest() {
  return new Request("https://webhooks.cc/api/teams/team_123/endpoints");
}

const ENDPOINT = {
  id: "ep_1",
  slug: "acme-one",
  name: "Acme",
  ownerId: "user_2",
  ownerName: null,
  ownerEmail: "member@example.com",
  sharedBy: "user_2",
  sharedAt: 1_790_000_000_000,
  requestCount: 42,
};

describe("GET /api/teams/[teamId]/endpoints", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.authenticateRequestRequireUser.mockResolvedValue({ success: true, userId: "user_1" });
    mocks.listTeamEndpoints.mockResolvedValue([ENDPOINT]);
  });

  test("lists the team's shared endpoints", async () => {
    const { GET } = await import("./route");
    const response = await GET(getRequest(), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ endpoints: [ENDPOINT] });
    expect(mocks.listTeamEndpoints).toHaveBeenCalledWith("user_1", "team_123");
  });

  test("answers 404 for a non-member", async () => {
    mocks.listTeamEndpoints.mockResolvedValue(null);

    const { GET } = await import("./route");
    const response = await GET(getRequest(), params);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Team not found" });
  });

  test("passes through an auth failure", async () => {
    mocks.authenticateRequestRequireUser.mockResolvedValue({
      success: false,
      response: Response.json({ error: "Invalid token" }, { status: 401 }),
    });

    const { GET } = await import("./route");
    const response = await GET(getRequest(), params);

    expect(response.status).toBe(401);
    expect(mocks.listTeamEndpoints).not.toHaveBeenCalled();
  });

  test("reports and returns 500 when the lookup throws", async () => {
    mocks.listTeamEndpoints.mockRejectedValue(new Error("db down"));

    const { GET } = await import("./route");
    const response = await GET(getRequest(), params);

    expect(response.status).toBe(500);
    expect(mocks.reportError).toHaveBeenCalledWith(
      "Failed to list team endpoints",
      expect.any(Error)
    );
  });
});
