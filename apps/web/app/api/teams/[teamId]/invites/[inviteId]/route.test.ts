import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequestRequireUser: vi.fn(),
  checkRateLimitByKeyWithInfo: vi.fn(),
  revokeInvite: vi.fn(),
  auditUserAction: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateRequestRequireUser: mocks.authenticateRequestRequireUser,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitByKeyWithInfo: mocks.checkRateLimitByKeyWithInfo,
  applyRateLimitHeaders: (response: Response) => response,
}));

vi.mock("@/lib/audit", () => ({
  auditUserAction: mocks.auditUserAction,
}));

vi.mock("@/lib/observability", () => ({
  reportError: mocks.reportError,
}));

vi.mock("@/lib/supabase/teams", () => ({
  revokeInvite: mocks.revokeInvite,
}));

const TEAM = "11111111-1111-4111-8111-111111111111";
const INVITE = "22222222-2222-4222-8222-222222222222";
const params = { params: Promise.resolve({ teamId: TEAM, inviteId: INVITE }) };

function deleteRequest() {
  return new Request(`https://webhooks.cc/api/teams/${TEAM}/invites/${INVITE}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/teams/[teamId]/invites/[inviteId]", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.authenticateRequestRequireUser.mockResolvedValue({ success: true, userId: "user_1" });
    mocks.checkRateLimitByKeyWithInfo.mockResolvedValue({ allowed: true });
    mocks.revokeInvite.mockResolvedValue(true);
  });

  test("revokes the invite and audits it", async () => {
    const { DELETE } = await import("./route");
    const response = await DELETE(deleteRequest(), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true });
    expect(mocks.revokeInvite).toHaveBeenCalledWith("user_1", TEAM, INVITE);
    expect(mocks.checkRateLimitByKeyWithInfo).toHaveBeenCalledWith(
      "team-invite:user_1",
      20,
      10 * 60_000
    );
    expect(mocks.auditUserAction).toHaveBeenCalledWith(expect.any(Request), "user_1", {
      action: "team.invite_revoked",
      status: 200,
      teamId: TEAM,
      targetId: INVITE,
    });
  });

  test("answers 404 without saying whether the invite or the ownership was missing", async () => {
    mocks.revokeInvite.mockResolvedValue(false);

    const { DELETE } = await import("./route");
    const response = await DELETE(deleteRequest(), params);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Invite not found" });
    expect(mocks.auditUserAction).toHaveBeenCalledWith(
      expect.any(Request),
      "user_1",
      expect.objectContaining({ action: "team.invite_revoked", status: 404 })
    );
  });

  test("passes through an auth failure", async () => {
    mocks.authenticateRequestRequireUser.mockResolvedValue({
      success: false,
      response: Response.json({ error: "Missing authorization header" }, { status: 401 }),
    });

    const { DELETE } = await import("./route");
    const response = await DELETE(deleteRequest(), params);

    expect(response.status).toBe(401);
    expect(mocks.revokeInvite).not.toHaveBeenCalled();
  });

  test("returns the rate limit response when limited", async () => {
    mocks.checkRateLimitByKeyWithInfo.mockResolvedValue({
      allowed: false,
      response: Response.json({ error: "Too many requests" }, { status: 429 }),
    });

    const { DELETE } = await import("./route");
    const response = await DELETE(deleteRequest(), params);

    expect(response.status).toBe(429);
    expect(mocks.revokeInvite).not.toHaveBeenCalled();
  });

  test("reports and returns 500 when the revoke throws", async () => {
    mocks.revokeInvite.mockRejectedValue(new Error("db down"));

    const { DELETE } = await import("./route");
    const response = await DELETE(deleteRequest(), params);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Internal server error" });
    expect(mocks.reportError).toHaveBeenCalledWith("Failed to revoke invite", expect.any(Error));
    expect(mocks.auditUserAction).toHaveBeenCalledWith(
      expect.any(Request),
      "user_1",
      expect.objectContaining({ action: "team.invite_revoked", status: 500 })
    );
  });
  test("answers 404 for a malformed id without querying or auditing", async () => {
    const { DELETE } = await import("./route");
    const response = await DELETE(deleteRequest(), {
      params: Promise.resolve({ teamId: "not-a-uuid", inviteId: INVITE }),
    });

    expect(response.status).toBe(404);
    expect(mocks.revokeInvite).not.toHaveBeenCalled();
    expect(mocks.auditUserAction).not.toHaveBeenCalled();
  });
});
