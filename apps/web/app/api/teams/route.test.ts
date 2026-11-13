import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequestRequireUser: vi.fn(),
  createTeam: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateRequestRequireUser: mocks.authenticateRequestRequireUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimitByKeyWithInfo: vi.fn().mockResolvedValue({ allowed: true }),
  applyRateLimitHeaders: (response: Response) => response,
}));
vi.mock("@/lib/audit", () => ({ auditUserAction: vi.fn() }));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/teams", () => ({
  createTeam: mocks.createTeam,
  listTeamsForUser: vi.fn(),
}));

function postRequest(body: string) {
  return new Request("https://webhooks.cc/api/teams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("POST /api/teams", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authenticateRequestRequireUser.mockResolvedValue({ success: true, userId: "user_1" });
    mocks.createTeam.mockResolvedValue({ id: "team_1", name: "Acme" });
  });

  test.each(["null", "[]", '"text"', "5", "{", ""])(
    "answers 400 to the malformed body %s",
    async (body) => {
      const { POST } = await import("./route");
      const response = await POST(postRequest(body));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
      expect(mocks.createTeam).not.toHaveBeenCalled();
    }
  );

  test.each(["{}", '{"name":1}', '{"name":null}', '{"name":"  "}'])(
    "keeps its own message for the name in %s",
    async (body) => {
      const { POST } = await import("./route");
      const response = await POST(postRequest(body));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Name must be between 1 and 100 characters",
      });
    }
  );

  test("creates the team under the trimmed name", async () => {
    const { POST } = await import("./route");
    const response = await POST(postRequest('{"name":" Acme "}'));

    expect(response.status).toBe(200);
    expect(mocks.createTeam).toHaveBeenCalledWith("user_1", "Acme");
  });
});
