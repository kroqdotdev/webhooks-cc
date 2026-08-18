import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  validateEvent: vi.fn(),
  applyPolarWebhookEvent: vi.fn(),
  applyTeamPolarWebhookEvent: vi.fn(),
}));

vi.mock("@polar-sh/sdk/webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polar-sh/sdk/webhooks")>();
  return {
    ...actual,
    validateEvent: mockFns.validateEvent,
  };
});

vi.mock("@/lib/supabase/billing", () => ({
  applyPolarWebhookEvent: mockFns.applyPolarWebhookEvent,
}));

// Partial mock: the real `extractTeamIdFromWebhook` is pure (no DB/Polar access), so the
// routing tests below exercise the actual payload-shape detection rather than a stub.
vi.mock("@/lib/supabase/team-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/team-billing")>();
  return {
    ...actual,
    applyTeamPolarWebhookEvent: mockFns.applyTeamPolarWebhookEvent,
  };
});

const previousSecret = process.env.POLAR_WEBHOOK_SECRET;
process.env.POLAR_WEBHOOK_SECRET = "whsec_test";

afterAll(() => {
  if (previousSecret === undefined) {
    delete process.env.POLAR_WEBHOOK_SECRET;
  } else {
    process.env.POLAR_WEBHOOK_SECRET = previousSecret;
  }
});

function webhookRequest() {
  return new Request("https://webhooks.cc/api/polar-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-signature": "sig" },
    body: JSON.stringify({ payload: true }),
  });
}

describe("POST /api/polar-webhook", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFns.applyPolarWebhookEvent.mockResolvedValue(undefined);
    mockFns.applyTeamPolarWebhookEvent.mockResolvedValue(undefined);
  });

  test("routes customer metadata team events to the team handler", async () => {
    const data = {
      customer: { id: "cus_1", externalId: "cus_1", metadata: { teamId: "team_meta" } },
    };
    mockFns.validateEvent.mockReturnValue({ type: "subscription.updated", data });

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mockFns.applyTeamPolarWebhookEvent).toHaveBeenCalledWith(
      "subscription.updated",
      "team_meta",
      data
    );
    expect(mockFns.applyPolarWebhookEvent).not.toHaveBeenCalled();
  });

  test("routes team: externalId events to the team handler", async () => {
    const data = { customer: { id: "cus_2", externalId: "team:abc", metadata: {} } };
    mockFns.validateEvent.mockReturnValue({ type: "subscription.active", data });

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(mockFns.applyTeamPolarWebhookEvent).toHaveBeenCalledWith(
      "subscription.active",
      "abc",
      data
    );
    expect(mockFns.applyPolarWebhookEvent).not.toHaveBeenCalled();
  });

  test("routes seat events carrying only seatMetadata to the team handler", async () => {
    // `customer_seat.*` payloads are a bare CustomerSeat with no customer object,
    // so seatMetadata.teamId is the only routing key. The route must forward the raw
    // event data untouched or these events lose their team entirely.
    const data = {
      id: "seat_1",
      status: "claimed",
      seatMetadata: { teamId: "team_seat", userId: "user_1" },
      customerEmail: "member@example.com",
    };
    mockFns.validateEvent.mockReturnValue({ type: "customer_seat.claimed", data });

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(mockFns.applyTeamPolarWebhookEvent).toHaveBeenCalledWith(
      "customer_seat.claimed",
      "team_seat",
      data
    );
    // Same object reference: no reshaping between validateEvent and the handler.
    expect(mockFns.applyTeamPolarWebhookEvent.mock.calls[0][2]).toBe(data);
    expect(mockFns.applyPolarWebhookEvent).not.toHaveBeenCalled();
  });

  test("routes personal events to the existing handler", async () => {
    const data = { customer: { id: "cus_3", externalId: "user_9", metadata: {} } };
    mockFns.validateEvent.mockReturnValue({ type: "subscription.updated", data });

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mockFns.applyPolarWebhookEvent).toHaveBeenCalledWith("subscription.updated", data);
    expect(mockFns.applyTeamPolarWebhookEvent).not.toHaveBeenCalled();
  });

  test("maps team handler failures to 500 internal_error", async () => {
    const data = { customer: { id: "cus_4", metadata: { teamId: "team_meta" } } };
    mockFns.validateEvent.mockReturnValue({ type: "subscription.canceled", data });
    mockFns.applyTeamPolarWebhookEvent.mockRejectedValue(new Error("team update failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal_error" });
    consoleError.mockRestore();
  });

  test("maps personal handler failures to 500 internal_error", async () => {
    const data = { customer: { id: "cus_5", metadata: {} } };
    mockFns.validateEvent.mockReturnValue({ type: "subscription.updated", data });
    mockFns.applyPolarWebhookEvent.mockRejectedValue(new Error("personal update failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal_error" });
    consoleError.mockRestore();
  });

  test("rejects invalid signatures before touching either handler", async () => {
    const { WebhookVerificationError } = await import("@polar-sh/sdk/webhooks");
    mockFns.validateEvent.mockImplementation(() => {
      throw new WebhookVerificationError("bad signature");
    });

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_signature" });
    expect(mockFns.applyPolarWebhookEvent).not.toHaveBeenCalled();
    expect(mockFns.applyTeamPolarWebhookEvent).not.toHaveBeenCalled();
  });
});
