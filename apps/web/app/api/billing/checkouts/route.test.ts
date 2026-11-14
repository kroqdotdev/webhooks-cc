import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequestRequireUser: vi.fn(),
  checkRateLimit: vi.fn(),
  auditUserAction: vi.fn(),
  reportError: vi.fn(),
  createCheckoutLink: vi.fn(),
  getCheckoutLink: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateRequestRequireUser: mocks.authenticateRequestRequireUser,
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/audit", () => ({ auditUserAction: mocks.auditUserAction }));
vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }));
vi.mock("@/lib/billing/checkout-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/checkout-links")>()),
  createCheckoutLink: mocks.createCheckoutLink,
  getCheckoutLink: mocks.getCheckoutLink,
}));

import { errors } from "@polar-sh/sdk/2026-10";
import { CheckoutLinkError } from "@/lib/billing/checkout-links";
import { BillingActionError } from "@/lib/supabase/billing";
import { CapacityError } from "@/lib/supabase/capacity-billing";
import { TeamBillingError } from "@/lib/supabase/team-billing";
import { POST } from "./route";
import { GET } from "./[id]/route";

const LINK = "11111111-2222-4333-8444-555555555555";
const TEAM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const view = {
  id: LINK,
  status: "open",
  kind: "plan",
  summary: "The Pro plan, billed monthly.",
  item: { kind: "plan", plan: "pro", interval: "month" },
  teamId: null,
  url: "https://polar.sh/checkout/polar_c_x",
  createdAt: "2026-11-14T12:00:00.000Z",
  expiresAt: "2026-11-14T13:00:00.000Z",
  paidAt: null,
};

const post = (body: unknown) =>
  POST(
    new Request("https://webhooks.cc/api/billing/checkouts", {
      method: "POST",
      headers: { Authorization: "Bearer whcc_test", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
const get = (id: string) =>
  GET(new Request(`https://webhooks.cc/api/billing/checkouts/${id}`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue(null);
  mocks.authenticateRequestRequireUser.mockResolvedValue({
    success: true,
    userId: "user-1",
    keyId: "key-1",
    agentRegistrationId: "agent-1",
  });
});

describe("POST /api/billing/checkouts", () => {
  it("makes a link for an API key or agent, with no approval, and audits it", async () => {
    mocks.createCheckoutLink.mockResolvedValue(view);
    const response = await post({ kind: "plan", plan: "pro" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ checkout: view });
    expect(mocks.createCheckoutLink).toHaveBeenCalledWith(
      { userId: "user-1", keyId: "key-1", agentRegistrationId: "agent-1" },
      { kind: "plan", plan: "pro", interval: "month" }
    );
    expect(mocks.auditUserAction).toHaveBeenCalledWith(expect.any(Request), "user-1", {
      action: "billing.checkout_link_created",
      status: 201,
      teamId: null,
      targetId: LINK,
      metadata: { kind: "plan", plan: "pro", interval: "month" },
    });
  });

  it("passes on the refusal of a pre-claim agent token", async () => {
    mocks.authenticateRequestRequireUser.mockResolvedValue({
      success: false,
      response: Response.json(
        { error: "This operation requires a claimed account." },
        { status: 403 }
      ),
    });
    expect((await post({ kind: "plan", plan: "pro" })).status).toBe(403);
    expect(mocks.createCheckoutLink).not.toHaveBeenCalled();
  });

  it("refuses a body that names nothing it can buy", async () => {
    const response = await post({ kind: "portal" });
    expect(response.status).toBe(400);
    expect(mocks.createCheckoutLink).not.toHaveBeenCalled();
  });

  it("answers and audits each refusal with its own status", async () => {
    const cases: Array<[unknown, number]> = [
      [new CheckoutLinkError("rate_limited", "At most 5 checkout links an hour", 429), 429],
      [new CheckoutLinkError("too_many_open", "3 checkout links are still open", 409), 409],
      [new TeamBillingError("not_owner", "Only the team owner can do this"), 403],
      [new BillingActionError("already_pro", "You already have a plan; change it instead"), 409],
      [new CapacityError("not_a_purchase", "A checkout link only adds blocks", 409), 409],
    ];
    for (const [error, status] of cases) {
      mocks.createCheckoutLink.mockRejectedValueOnce(error);
      const response = await post({ kind: "team_plan", teamId: TEAM, seats: 3 });
      expect(response.status).toBe(status);
      expect(mocks.auditUserAction).toHaveBeenLastCalledWith(
        expect.any(Request),
        "user-1",
        expect.objectContaining({
          action: "billing.checkout_link_created",
          status,
          teamId: TEAM,
          reason: (error as Error).message,
        })
      );
    }
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("never reports or audits a raw Polar error", async () => {
    const polarError = new errors.HTTPValidationError(422, {
      detail: [
        {
          loc: ["body", "customer_email"],
          msg: "Invalid email",
          type: "value_error",
          input: "jane@example.com",
        },
      ],
    } as never);
    mocks.createCheckoutLink.mockRejectedValue(polarError);
    const response = await post({ kind: "plan", plan: "business", interval: "year" });
    expect(response.status).toBe(500);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError.mock.calls[0][1]).not.toBe(polarError);
    expect(JSON.stringify(mocks.reportError.mock.calls[0][1])).not.toContain("jane@example.com");
    expect(mocks.auditUserAction.mock.calls[0][2].reason).toBeUndefined();
  });

  it("is rate limited per address before anything else", async () => {
    mocks.checkRateLimit.mockResolvedValue(Response.json({}, { status: 429 }));
    expect((await post({ kind: "plan", plan: "pro" })).status).toBe(429);
    expect(mocks.authenticateRequestRequireUser).not.toHaveBeenCalled();
  });
});

describe("GET /api/billing/checkouts/{id}", () => {
  it("answers the asker's own link", async () => {
    mocks.getCheckoutLink.mockResolvedValue({ ...view, status: "paid", url: null });
    const response = await get(LINK);
    expect(response.status).toBe(200);
    expect((await response.json()).checkout.status).toBe("paid");
    expect(mocks.getCheckoutLink).toHaveBeenCalledWith(LINK, "user-1");
  });

  it("answers 404 for someone else's link and for ids that are not one", async () => {
    mocks.getCheckoutLink.mockResolvedValue(null);
    expect((await get(LINK)).status).toBe(404);
    expect((await get("../approvals")).status).toBe(404);
    expect(mocks.getCheckoutLink).toHaveBeenCalledTimes(1);
  });
});
