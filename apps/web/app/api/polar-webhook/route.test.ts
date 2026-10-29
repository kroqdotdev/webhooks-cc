import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  validateEvent: vi.fn(),
  applyPolarWebhookEvent: vi.fn(),
  resolveWebhookUserId: vi.fn(),
  applyTeamPolarWebhookEvent: vi.fn(),
  applyCapacityWebhookEvent: vi.fn(),
  reconcileAddonsWithPlan: vi.fn(),
  auditPolarEvent: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  auditPolarEvent: mockFns.auditPolarEvent,
}));

// The SDK's `webhooks` namespace is getter-only, so replace the whole module
// export rather than spying on validateEvent.
vi.mock("@polar-sh/sdk/2026-10", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polar-sh/sdk/2026-10")>();
  return {
    ...actual,
    webhooks: { ...actual.webhooks, validateEvent: mockFns.validateEvent },
  };
});

vi.mock("@/lib/supabase/billing", () => ({
  applyPolarWebhookEvent: mockFns.applyPolarWebhookEvent,
  resolveWebhookUserId: mockFns.resolveWebhookUserId,
}));

// Partial mock: product matching is real (it reads the product env vars set
// below); applying events and reconciling add-ons are stubbed.
vi.mock("@/lib/supabase/capacity-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/capacity-billing")>();
  return {
    ...actual,
    applyCapacityWebhookEvent: mockFns.applyCapacityWebhookEvent,
    reconcileAddonsWithPlan: mockFns.reconcileAddonsWithPlan,
  };
});

const CAPACITY_PRODUCTS = {
  POLAR_REQUEST_BLOCKS_PRODUCT_ID: "prod_one_time",
  POLAR_MONTHLY_BLOCKS_PRODUCT_ID: "prod_monthly",
  POLAR_MONTHLY_BLOCKS_ADD_PRODUCT_ID: "prod_monthly_add",
  POLAR_OVERAGE_PRODUCT_ID: "prod_overage",
};
const previousProducts = Object.fromEntries(
  Object.keys(CAPACITY_PRODUCTS).map((key) => [key, process.env[key]])
);
Object.assign(process.env, CAPACITY_PRODUCTS);

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
  for (const [key, value] of Object.entries(previousProducts)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
    mockFns.applyCapacityWebhookEvent.mockResolvedValue(undefined);
    mockFns.reconcileAddonsWithPlan.mockResolvedValue(undefined);
    mockFns.resolveWebhookUserId.mockResolvedValue("user_9");
  });

  test("routes add-on subscriptions to the capacity handler, never the plan handlers", async () => {
    const data = {
      id: "sub_overage",
      product_id: "prod_overage",
      customer: { id: "cus_3", external_id: "user_9", metadata: {} },
    };
    mockFns.validateEvent.mockResolvedValue({ type: "subscription.revoked", data });

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(mockFns.applyCapacityWebhookEvent).toHaveBeenCalledWith(
      "subscription.revoked",
      { kind: "user", userId: "user_9" },
      { resource: "requests", kind: "overage" },
      data
    );
    expect(mockFns.applyPolarWebhookEvent).not.toHaveBeenCalled();
    expect(mockFns.reconcileAddonsWithPlan).not.toHaveBeenCalled();
  });

  test("routes a team's one-time block order to the capacity handler for the team", async () => {
    const data = {
      id: "ord_1",
      product: { id: "prod_one_time" },
      customer: { id: "cus_1", external_id: "team:team_7", metadata: { teamId: "team_7" } },
    };
    mockFns.validateEvent.mockResolvedValue({ type: "order.paid", data });

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    expect(mockFns.applyCapacityWebhookEvent).toHaveBeenCalledWith(
      "order.paid",
      { kind: "team", teamId: "team_7" },
      { resource: "requests", kind: "one_time" },
      data
    );
    expect(mockFns.applyTeamPolarWebhookEvent).not.toHaveBeenCalled();
  });

  test("brings add-ons in line after a plan subscription event, not after other events", async () => {
    const data = {
      id: "sub_pro",
      product_id: "prod_pro",
      customer: { id: "cus_3", external_id: "user_9", metadata: {} },
    };
    mockFns.validateEvent.mockResolvedValueOnce({ type: "subscription.canceled", data });

    const { POST } = await import("./route");
    await POST(webhookRequest());
    expect(mockFns.applyPolarWebhookEvent).toHaveBeenCalledWith("subscription.canceled", data);
    expect(mockFns.reconcileAddonsWithPlan).toHaveBeenCalledWith({
      kind: "user",
      userId: "user_9",
    });

    mockFns.reconcileAddonsWithPlan.mockClear();
    mockFns.validateEvent.mockResolvedValueOnce({ type: "order.paid", data });
    await POST(webhookRequest());
    expect(mockFns.reconcileAddonsWithPlan).not.toHaveBeenCalled();
  });

  test("routes customer metadata team events to the team handler", async () => {
    const data = {
      customer: { id: "cus_1", external_id: "cus_1", metadata: { teamId: "team_meta" } },
    };
    mockFns.validateEvent.mockResolvedValue({ type: "subscription.updated", data });

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
    expect(mockFns.auditPolarEvent).toHaveBeenCalledWith({
      eventType: "subscription.updated",
      teamId: "team_meta",
      data,
      outcome: "ok",
    });
  });

  test("routes team: external_id events to the team handler", async () => {
    const data = { customer: { id: "cus_2", external_id: "team:abc", metadata: {} } };
    mockFns.validateEvent.mockResolvedValue({ type: "subscription.active", data });

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

  test("routes seat events carrying only seat_metadata to the team handler", async () => {
    // `customer_seat.*` payloads are a bare CustomerSeat with no customer object,
    // so seat_metadata.teamId is the only routing key. The route must forward the raw
    // event data untouched or these events lose their team entirely.
    const data = {
      id: "seat_1",
      status: "claimed",
      seat_metadata: { teamId: "team_seat", userId: "user_1" },
      customer_email: "member@example.com",
    };
    mockFns.validateEvent.mockResolvedValue({ type: "customer_seat.claimed", data });

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
    const data = { customer: { id: "cus_3", external_id: "user_9", metadata: {} } };
    mockFns.validateEvent.mockResolvedValue({ type: "subscription.updated", data });

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mockFns.applyPolarWebhookEvent).toHaveBeenCalledWith("subscription.updated", data);
    expect(mockFns.applyTeamPolarWebhookEvent).not.toHaveBeenCalled();
  });

  test("maps team handler failures to 500 internal_error", async () => {
    const data = { customer: { id: "cus_4", metadata: { teamId: "team_meta" } } };
    mockFns.validateEvent.mockResolvedValue({ type: "subscription.canceled", data });
    mockFns.applyTeamPolarWebhookEvent.mockRejectedValue(new Error("team update failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal_error" });
    expect(mockFns.auditPolarEvent).toHaveBeenCalledWith({
      eventType: "subscription.canceled",
      teamId: "team_meta",
      data,
      outcome: "error",
    });
    consoleError.mockRestore();
  });

  test("maps personal handler failures to 500 internal_error", async () => {
    const data = { customer: { id: "cus_5", metadata: {} } };
    mockFns.validateEvent.mockResolvedValue({ type: "subscription.updated", data });
    mockFns.applyPolarWebhookEvent.mockRejectedValue(new Error("personal update failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal_error" });
    consoleError.mockRestore();
  });

  test("rejects invalid signatures before touching either handler", async () => {
    const { webhooks } = await import("@polar-sh/sdk/2026-10");
    mockFns.validateEvent.mockRejectedValue(
      new webhooks.PolarWebhookVerificationError("bad signature")
    );

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_signature" });
    expect(mockFns.applyPolarWebhookEvent).not.toHaveBeenCalled();
    expect(mockFns.applyTeamPolarWebhookEvent).not.toHaveBeenCalled();
    expect(mockFns.auditPolarEvent).not.toHaveBeenCalled();
  });

  test("acknowledges a correctly signed event of a type the SDK does not know", async () => {
    // Polar disables an endpoint after 10 consecutive failed deliveries, so a
    // new event type must not be answered with an error.
    const { webhooks } = await import("@polar-sh/sdk/2026-10");
    mockFns.validateEvent.mockRejectedValue(
      new webhooks.PolarWebhookUnknownTypeError("subscription.brand_new")
    );

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mockFns.applyPolarWebhookEvent).not.toHaveBeenCalled();
    expect(mockFns.applyTeamPolarWebhookEvent).not.toHaveBeenCalled();
  });

  test("rejects a payload the SDK cannot parse", async () => {
    const { webhooks } = await import("@polar-sh/sdk/2026-10");
    mockFns.validateEvent.mockRejectedValue(new webhooks.PolarWebhookError("not JSON"));

    const { POST } = await import("./route");
    const response = await POST(webhookRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_payload" });
    expect(mockFns.applyPolarWebhookEvent).not.toHaveBeenCalled();
  });
});
