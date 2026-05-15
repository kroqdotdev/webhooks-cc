import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  validateNotificationUrl: vi.fn(),
  validateMockResponseField: vi.fn(),
  validateResponseRules: vi.fn(),
  resolveEndpointAccess: vi.fn(),
  getEndpointBySlugForUser: vi.fn(),
  updateEndpointBySlugForUser: vi.fn(),
  deleteEndpointBySlugForUser: vi.fn(),
  isSigningKeyConfigured: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateRequest: mockFns.authenticateRequest,
}));

vi.mock("@/lib/request-validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/request-validation")>();
  return {
    ...actual,
    validateNotificationUrl: mockFns.validateNotificationUrl,
    validateMockResponseField: mockFns.validateMockResponseField,
    validateResponseRules: mockFns.validateResponseRules,
  };
});

vi.mock("@/lib/supabase/teams", () => ({
  resolveEndpointAccess: mockFns.resolveEndpointAccess,
}));

vi.mock("@/lib/supabase/endpoints", () => ({
  getEndpointBySlugForUser: mockFns.getEndpointBySlugForUser,
  updateEndpointBySlugForUser: mockFns.updateEndpointBySlugForUser,
  deleteEndpointBySlugForUser: mockFns.deleteEndpointBySlugForUser,
}));

vi.mock("@/lib/crypto", () => ({
  isSigningKeyConfigured: mockFns.isSigningKeyConfigured,
}));

const params = { params: Promise.resolve({ slug: "demo" }) };

function patchRequest(body: Record<string, unknown>) {
  return new Request("https://webhooks.cc/api/endpoints/demo", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/endpoints/[slug]", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFns.authenticateRequest.mockResolvedValue({ success: true, userId: "user_123" });
    mockFns.validateNotificationUrl.mockReturnValue({ valid: true });
    mockFns.validateMockResponseField.mockReturnValue({ valid: true });
    mockFns.validateResponseRules.mockReturnValue({ valid: true });
    mockFns.resolveEndpointAccess.mockResolvedValue({
      ownerId: "owner_123",
      endpointId: "endpoint_123",
      isOwner: true,
    });
    mockFns.getEndpointBySlugForUser.mockResolvedValue({
      signingProvider: null,
      hasSigningSecret: false,
      signingHeader: null,
    });
    mockFns.updateEndpointBySlugForUser.mockResolvedValue({ slug: "demo" });
    mockFns.isSigningKeyConfigured.mockReturnValue(true);
  });

  test("rejects SendGrid as a signing provider", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ signingProvider: "sendgrid" }), params);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid signing provider" });
    expect(mockFns.updateEndpointBySlugForUser).not.toHaveBeenCalled();
  });

  test("requires a fresh secret when changing provider", async () => {
    mockFns.getEndpointBySlugForUser.mockResolvedValue({
      signingProvider: "stripe",
      hasSigningSecret: true,
      signingHeader: null,
    });

    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ signingProvider: "github" }), params);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A signing secret is required for github",
    });
    expect(mockFns.updateEndpointBySlugForUser).not.toHaveBeenCalled();
  });

  test("requires a header when configuring Generic HMAC", async () => {
    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({ signingProvider: "generic-hmac", signingSecret: "secret" }),
      params
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid signing header name" });
    expect(mockFns.updateEndpointBySlugForUser).not.toHaveBeenCalled();
  });

  test("checks signing key only after endpoint access succeeds", async () => {
    mockFns.resolveEndpointAccess.mockResolvedValue(null);
    mockFns.isSigningKeyConfigured.mockReturnValue(false);

    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ signingSecret: "secret" }), params);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Endpoint not found" });
    expect(mockFns.isSigningKeyConfigured).not.toHaveBeenCalled();
    expect(mockFns.updateEndpointBySlugForUser).not.toHaveBeenCalled();
  });

  test("rejects owner-only notification updates from team members", async () => {
    mockFns.resolveEndpointAccess.mockResolvedValue({
      ownerId: "owner_123",
      endpointId: "endpoint_123",
      isOwner: false,
    });

    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({ notificationUrl: "https://example.com/webhook" }),
      params
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the endpoint owner can update notification or signing settings",
    });
    expect(mockFns.getEndpointBySlugForUser).not.toHaveBeenCalled();
    expect(mockFns.updateEndpointBySlugForUser).not.toHaveBeenCalled();
  });

  test("rejects owner-only signing updates from team members", async () => {
    mockFns.resolveEndpointAccess.mockResolvedValue({
      ownerId: "owner_123",
      endpointId: "endpoint_123",
      isOwner: false,
    });

    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({ signingProvider: "stripe", signingSecret: "whsec_test" }),
      params
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Only the endpoint owner can update notification or signing settings",
    });
    expect(mockFns.getEndpointBySlugForUser).not.toHaveBeenCalled();
    expect(mockFns.updateEndpointBySlugForUser).not.toHaveBeenCalled();
  });

  test("allows team members to update non-secret endpoint settings", async () => {
    mockFns.resolveEndpointAccess.mockResolvedValue({
      ownerId: "owner_123",
      endpointId: "endpoint_123",
      isOwner: false,
    });

    const { PATCH } = await import("./route");
    const response = await PATCH(patchRequest({ name: "Shared Demo" }), params);

    expect(response.status).toBe(200);
    expect(mockFns.updateEndpointBySlugForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner_123",
        slug: "demo",
        name: "Shared Demo",
      })
    );
  });

  test("returns 503 for valid signing updates when the encryption key is missing", async () => {
    mockFns.isSigningKeyConfigured.mockReturnValue(false);

    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({
        signingProvider: "stripe",
        signingSecret: "whsec_test",
      }),
      params
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Signature verification is not available. Contact support.",
    });
    expect(mockFns.updateEndpointBySlugForUser).not.toHaveBeenCalled();
  });
});
