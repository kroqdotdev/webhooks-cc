import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequestRequireUser: vi.fn(),
  authenticateSessionRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  checkRateLimitByKey: vi.fn(),
  auditUserAction: vi.fn(),
  reportError: vi.fn(),
  createCheckoutLink: vi.fn(),
  getCheckoutLink: vi.fn(),
  openCheckoutLink: vi.fn(),
  expireCheckoutLink: vi.fn(),
  reviewCheckoutLink: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateRequestRequireUser: mocks.authenticateRequestRequireUser,
  authenticateSessionRequest: mocks.authenticateSessionRequest,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  checkRateLimitByKey: mocks.checkRateLimitByKey,
  getClientIp: (request: Request) => request.headers.get("cf-connecting-ip") ?? "unknown",
  rateLimitWideIpBucket: (ip: string) => `${ip.split(".").slice(0, 3).join(".")}.0/24`,
}));
vi.mock("@/lib/audit", () => ({ auditUserAction: mocks.auditUserAction }));
vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }));
vi.mock("@/lib/billing/checkout-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/checkout-links")>()),
  createCheckoutLink: mocks.createCheckoutLink,
  getCheckoutLink: mocks.getCheckoutLink,
  openCheckoutLink: mocks.openCheckoutLink,
  expireCheckoutLink: mocks.expireCheckoutLink,
  reviewCheckoutLink: mocks.reviewCheckoutLink,
}));

import { errors } from "@polar-sh/sdk/2026-10";
import { CheckoutLinkError } from "@/lib/billing/checkout-links";
import { BillingActionError } from "@/lib/supabase/billing";
import { CapacityError } from "@/lib/supabase/capacity-billing";
import { TeamBillingError } from "@/lib/supabase/team-billing";
import { POST } from "./route";
import { DELETE, GET } from "./[id]/route";
import { POST as OPEN } from "./[id]/open/route";
import { GET as REVIEW } from "./[id]/review/route";

const LINK = "11111111-2222-4333-8444-555555555555";
const TEAM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const view = {
  id: LINK,
  status: "open",
  kind: "plan",
  summary: "The Pro plan, billed monthly.",
  item: { kind: "plan", plan: "pro", interval: "month" },
  teamId: null,
  url: `https://webhooks.cc/checkout/${LINK}`,
  createdAt: "2026-11-14T12:00:00.000Z",
  expiresAt: "2026-11-14T13:00:00.000Z",
  paidAt: null,
  bought: null,
  matches: null,
};

const post = (body: unknown) =>
  POST(
    new Request("https://webhooks.cc/api/billing/checkouts", {
      method: "POST",
      headers: { Authorization: "Bearer whcc_test", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
const open = (id: string) =>
  OPEN(new Request(`https://webhooks.cc/api/billing/checkouts/${id}/open`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
const cancel = (id: string) =>
  DELETE(new Request(`https://webhooks.cc/api/billing/checkouts/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
const review = (id: string, headers: Record<string, string> = {}) =>
  REVIEW(new Request(`https://webhooks.cc/api/billing/checkouts/${id}/review`, { headers }), {
    params: Promise.resolve({ id }),
  });
const get = (id: string) =>
  GET(new Request(`https://webhooks.cc/api/billing/checkouts/${id}`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkRateLimit.mockResolvedValue(null);
  mocks.checkRateLimitByKey.mockResolvedValue(null);
  mocks.authenticateRequestRequireUser.mockResolvedValue({
    success: true,
    userId: "user-1",
    keyId: "key-1",
    agentRegistrationId: "agent-1",
  });
});

describe("POST /api/billing/checkouts", () => {
  it("counts attempts per asking person, 30 an hour, before making anything", async () => {
    mocks.createCheckoutLink.mockResolvedValue(view);
    await post({ kind: "plan", plan: "pro" });
    expect(mocks.checkRateLimitByKey).toHaveBeenLastCalledWith(
      "billing-checkouts:user:user-1",
      30,
      3_600_000
    );
    // A team's purchase counts against the person asking, never the team.
    await post({ kind: "overage", teamId: TEAM });
    expect(mocks.checkRateLimitByKey).toHaveBeenLastCalledWith(
      "billing-checkouts:user:user-1",
      30,
      3_600_000
    );

    mocks.createCheckoutLink.mockClear();
    mocks.auditUserAction.mockClear();
    mocks.checkRateLimitByKey.mockResolvedValueOnce(
      Response.json({ error: "Too many requests" }, { status: 429 })
    );
    const limited = await post({ kind: "plan", plan: "pro" });
    expect(limited.status).toBe(429);
    expect(mocks.createCheckoutLink).not.toHaveBeenCalled();
    expect(mocks.auditUserAction).not.toHaveBeenCalled();
  });

  it("leaves the team owner's attempts alone when a member's are used up", async () => {
    // A counting limiter, keyed as the route keys it.
    const used = new Map<string, number>();
    mocks.checkRateLimitByKey.mockImplementation(async (key: string, limit: number) => {
      const n = (used.get(key) ?? 0) + 1;
      used.set(key, n);
      return n > limit ? Response.json({ error: "Too many requests" }, { status: 429 }) : null;
    });
    const as = (userId: string) =>
      mocks.authenticateRequestRequireUser.mockResolvedValue({ success: true, userId });
    const team = { kind: "team_plan", teamId: TEAM, seats: 3 };

    // The member is refused 30 times (not the owner), then limited.
    as("member-1");
    mocks.createCheckoutLink.mockRejectedValue(
      new TeamBillingError("not_owner", "Only the team owner can manage billing")
    );
    for (let i = 0; i < 30; i++) expect((await post(team)).status).toBe(403);
    expect((await post(team)).status).toBe(429);

    // The owner still has every attempt.
    as("owner-1");
    mocks.createCheckoutLink.mockResolvedValue({ ...view, kind: "team_plan", teamId: TEAM });
    expect((await post(team)).status).toBe(201);
    expect(used.get("billing-checkouts:user:owner-1")).toBe(1);
    expect([...used.keys()].some((key) => key.includes(TEAM))).toBe(false);
  });

  it("makes a link for an API key or agent, with no approval, and audits it", async () => {
    mocks.createCheckoutLink.mockResolvedValue(view);
    const response = await post({ kind: "plan", plan: "pro" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ checkout: view });
    expect(mocks.createCheckoutLink).toHaveBeenCalledWith(
      {
        userId: "user-1",
        keyId: "key-1",
        agentRegistrationId: "agent-1",
        network: null,
        country: null,
      },
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

describe("POST /api/billing/checkouts/{id}/open", () => {
  beforeEach(() => {
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user-1" });
  });

  it("sends the owner's session on to Polar, and audits it", async () => {
    mocks.openCheckoutLink.mockResolvedValue({
      kind: "redirect",
      url: "https://sandbox.polar.sh/checkout/polar_c_x",
      summary: view.summary,
      link: { kind: "plan", resource: null },
    });
    const response = await open(LINK);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "redirect",
      url: "https://sandbox.polar.sh/checkout/polar_c_x",
      summary: view.summary,
      kind: "plan",
      resource: null,
    });
    expect(mocks.openCheckoutLink).toHaveBeenCalledWith(LINK, "user-1");
    expect(mocks.auditUserAction).toHaveBeenCalledWith(expect.any(Request), "user-1", {
      action: "billing.checkout_link_opened",
      status: 200,
      targetId: LINK,
    });
  });

  it("answers where a link stands without a checkout", async () => {
    mocks.openCheckoutLink.mockResolvedValue({
      kind: "paid",
      summary: view.summary,
      link: { kind: "plan", resource: null },
    });
    expect(await (await open(LINK)).json()).toEqual({
      status: "paid",
      summary: view.summary,
      kind: "plan",
      resource: null,
    });
    expect(mocks.auditUserAction).not.toHaveBeenCalled();
  });

  it("names what a superseded link bought, for a page that has no review to go on", async () => {
    mocks.openCheckoutLink.mockResolvedValue({
      kind: "superseded",
      summary: "2 monthly blocks of 25,000 requests in all for the account.",
      link: { kind: "monthly_blocks", resource: "requests" },
    });
    expect(await (await open(LINK)).json()).toMatchObject({
      status: "superseded",
      kind: "monthly_blocks",
      resource: "requests",
    });
  });

  it("refuses an API key or agent token: Polar's checkout never reaches one", async () => {
    mocks.authenticateSessionRequest.mockResolvedValue({
      success: false,
      response: Response.json({ error: "API keys are not allowed" }, { status: 403 }),
    });
    expect((await open(LINK)).status).toBe(403);
    expect(mocks.openCheckoutLink).not.toHaveBeenCalled();
  });

  it("refuses another account plainly, and audits it", async () => {
    mocks.openCheckoutLink.mockRejectedValue(
      new CheckoutLinkError("wrong_account", "This checkout link is for another account.", 403)
    );
    const response = await open(LINK);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "wrong_account" });
    expect(mocks.auditUserAction).toHaveBeenCalledWith(
      expect.any(Request),
      "user-1",
      expect.objectContaining({ action: "billing.checkout_link_opened", status: 403 })
    );
  });

  it("answers 404 for an id that is not one", async () => {
    expect((await open("../approvals")).status).toBe(404);
    expect(mocks.openCheckoutLink).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/billing/checkouts/{id}", () => {
  it("cancels a link nobody opened, for any key of the asker, and audits it", async () => {
    mocks.expireCheckoutLink.mockResolvedValue({ ...view, status: "expired", url: null });
    const response = await cancel(LINK);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checkout: { status: "expired", url: null } });
    expect(mocks.expireCheckoutLink).toHaveBeenCalledWith(LINK, "user-1");
    expect(mocks.auditUserAction).toHaveBeenCalledWith(expect.any(Request), "user-1", {
      action: "billing.checkout_link_canceled",
      status: 200,
      teamId: null,
      targetId: LINK,
    });
  });

  it("answers and audits a link already opened as a refusal", async () => {
    mocks.expireCheckoutLink.mockRejectedValue(
      new CheckoutLinkError("opened", "The person already opened this link.", 409)
    );
    const response = await cancel(LINK);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "opened" });
    expect(mocks.auditUserAction).toHaveBeenCalledWith(
      expect.any(Request),
      "user-1",
      expect.objectContaining({ action: "billing.checkout_link_canceled", status: 409 })
    );
  });

  it("answers 404 for an id that is not one", async () => {
    expect((await cancel("../approvals")).status).toBe(404);
    expect(mocks.expireCheckoutLink).not.toHaveBeenCalled();
  });
});

describe("GET /api/billing/checkouts/{id}/review", () => {
  beforeEach(() => {
    mocks.authenticateSessionRequest.mockResolvedValue({ success: true, userId: "user-1" });
  });

  it("answers the owner's session with what the page shows, from this browser's network", async () => {
    const answer = { id: LINK, status: "open", summary: view.summary, network: "same" };
    mocks.reviewCheckoutLink.mockResolvedValue(answer);
    const response = await review(LINK, { "cf-connecting-ip": "203.0.113.9" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ review: answer });
    expect(mocks.reviewCheckoutLink).toHaveBeenCalledWith(LINK, "user-1", "203.0.113.0/24");
    // Reading makes nothing, so nothing is audited.
    expect(mocks.auditUserAction).not.toHaveBeenCalled();
    expect(mocks.openCheckoutLink).not.toHaveBeenCalled();
  });

  it("refuses an API key or agent token, and another account", async () => {
    mocks.authenticateSessionRequest.mockResolvedValueOnce({
      success: false,
      response: Response.json({ error: "API keys are not allowed" }, { status: 403 }),
    });
    expect((await review(LINK)).status).toBe(403);
    expect(mocks.reviewCheckoutLink).not.toHaveBeenCalled();

    mocks.reviewCheckoutLink.mockRejectedValue(
      new CheckoutLinkError("wrong_account", "This checkout link is for another account.", 403)
    );
    const other = await review(LINK);
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: "wrong_account" });
    expect((await review("../approvals")).status).toBe(404);
  });
});
