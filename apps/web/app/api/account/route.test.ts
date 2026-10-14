import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateSessionRequest: vi.fn(),
  checkRateLimitByKeyWithInfo: vi.fn(),
  updateDisplayName: vi.fn(),
  auditUserAction: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateSessionRequest: mocks.authenticateSessionRequest,
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

vi.mock("@/lib/supabase/account", () => ({
  AccountDeletionBillingError: class extends Error {},
  deleteAccountForUser: vi.fn(),
}));

vi.mock("@/lib/supabase/profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/profile")>();
  return { ...actual, updateDisplayName: mocks.updateDisplayName };
});

function patchRequest(body: unknown) {
  return new Request("https://webhooks.cc/api/account", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PATCH /api/account", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user_1" });
    mocks.checkRateLimitByKeyWithInfo.mockResolvedValue({ allowed: true });
    mocks.updateDisplayName.mockImplementation(async (_userId: string, name: string | null) => {
      return name ?? "Provider Name";
    });
  });

  test("sets a trimmed name and returns the effective name", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ name: "  Ada Lovelace " }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ name: "Ada Lovelace" });
    expect(mocks.updateDisplayName).toHaveBeenCalledWith("user_1", "Ada Lovelace");
    expect(mocks.checkRateLimitByKeyWithInfo).toHaveBeenCalledWith(
      "account-name:user_1",
      expect.any(Number),
      expect.any(Number)
    );
    expect(mocks.auditUserAction).toHaveBeenCalledWith(
      expect.any(Request),
      "user_1",
      expect.objectContaining({ action: "account.name_updated", status: 200 })
    );
  });

  test.each([null, "", "   "])("clears the override for %j", async (name) => {
    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ name }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ name: "Provider Name" });
    expect(mocks.updateDisplayName).toHaveBeenCalledWith("user_1", null);
  });

  test("rejects a name over 80 characters", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ name: "a".repeat(81) }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Name must be 80 characters or fewer",
    });
    expect(mocks.updateDisplayName).not.toHaveBeenCalled();
  });

  test("rejects control characters", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ name: "Ada\nLovelace" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Name cannot contain control characters",
    });
  });

  test("rejects a body without a name field, a non-string name and invalid JSON", async () => {
    const { PATCH } = await import("./route");

    const missing = await PATCH(patchRequest({}));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({
      error: "name is required (a string, or null to clear it)",
    });

    const wrongType = await PATCH(patchRequest({ name: 7 }));
    expect(wrongType.status).toBe(400);

    const invalid = await PATCH(patchRequest("{not json"));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid JSON body" });

    expect(mocks.updateDisplayName).not.toHaveBeenCalled();
  });

  test("passes through an auth failure, such as an API key or agent token", async () => {
    mocks.authenticateSessionRequest.mockResolvedValue({
      success: false,
      response: Response.json(
        { error: "API keys are not allowed for this operation. Use a session token." },
        { status: 403 }
      ),
    });

    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ name: "Ada" }));

    expect(response.status).toBe(403);
    expect(mocks.updateDisplayName).not.toHaveBeenCalled();
  });

  test("returns the rate limit response when limited", async () => {
    mocks.checkRateLimitByKeyWithInfo.mockResolvedValue({
      allowed: false,
      response: Response.json({ error: "Too many requests" }, { status: 429 }),
    });

    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ name: "Ada" }));

    expect(response.status).toBe(429);
    expect(mocks.updateDisplayName).not.toHaveBeenCalled();
  });

  test("reports and returns 500 when the update fails", async () => {
    mocks.updateDisplayName.mockRejectedValue(new Error("auth down"));

    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ name: "Ada" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to update name" });
    expect(mocks.reportError).toHaveBeenCalledWith("Display name update failed", expect.any(Error));
    expect(mocks.auditUserAction).toHaveBeenCalledWith(
      expect.any(Request),
      "user_1",
      expect.objectContaining({ action: "account.name_updated", status: 500 })
    );
  });
});
