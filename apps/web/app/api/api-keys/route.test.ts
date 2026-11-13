import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ApiKeyLimitError extends Error {}
  return {
    ApiKeyLimitError,
    authenticateRequestRequireUser: vi.fn(),
    requestApproval: vi.fn(),
    createApiKeyForUser: vi.fn(),
    auditUserAction: vi.fn(),
  };
});

vi.mock("@/lib/api-auth", () => ({
  authenticateRequestRequireUser: mocks.authenticateRequestRequireUser,
}));
vi.mock("@/lib/approvals/request", () => ({ requestApproval: mocks.requestApproval }));
vi.mock("@/lib/audit", () => ({ auditUserAction: mocks.auditUserAction }));
vi.mock("@/lib/supabase/api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/api-keys")>()),
  ApiKeyLimitError: mocks.ApiKeyLimitError,
  createApiKeyForUser: mocks.createApiKeyForUser,
}));

import { POST } from "./route";

function post(body: unknown) {
  return new Request("https://webhooks.cc/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/api-keys", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks the owner when an API key or agent token calls it", async () => {
    mocks.authenticateRequestRequireUser.mockResolvedValue({
      success: true,
      userId: "user-1",
      keyId: "key-1",
      agentRegistrationId: "reg-1",
    });
    mocks.requestApproval.mockResolvedValue(Response.json({ approval: {} }, { status: 202 }));
    const response = await POST(post({ name: "CI", expiresInDays: 30 }));
    expect(response.status).toBe(202);
    expect(mocks.requestApproval).toHaveBeenCalledWith(
      expect.any(Request),
      { userId: "user-1", keyId: "key-1", agentRegistrationId: "reg-1" },
      "api_keys.create",
      { name: "CI", expiresInDays: 30 }
    );
    expect(mocks.createApiKeyForUser).not.toHaveBeenCalled();
  });

  it("creates the key at once for a browser session", async () => {
    mocks.authenticateRequestRequireUser.mockResolvedValue({ success: true, userId: "user-1" });
    mocks.createApiKeyForUser.mockResolvedValue({
      key: "whcc_x",
      name: "CI",
      keyPrefix: "whcc_x",
      expiresAt: "2027-11-13T00:00:00.000Z",
    });
    const response = await POST(post({ name: "  CI  " }));
    expect(response.status).toBe(200);
    expect(mocks.createApiKeyForUser).toHaveBeenCalledWith("user-1", "CI", 365);
    expect(mocks.requestApproval).not.toHaveBeenCalled();
  });

  it("refuses a lifetime past a year, and a missing name", async () => {
    mocks.authenticateRequestRequireUser.mockResolvedValue({ success: true, userId: "user-1" });
    expect((await POST(post({ name: "CI", expiresInDays: 400 }))).status).toBe(400);
    expect((await POST(post({ name: " " }))).status).toBe(400);
  });

  it("answers 409 at the key cap", async () => {
    mocks.authenticateRequestRequireUser.mockResolvedValue({ success: true, userId: "user-1" });
    mocks.createApiKeyForUser.mockRejectedValue(new mocks.ApiKeyLimitError("Maximum"));
    expect((await POST(post({ name: "CI" }))).status).toBe(409);
  });
});
