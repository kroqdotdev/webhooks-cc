import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditUserAction: vi.fn(),
  deviceApprover: vi.fn(),
  decideApproval: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ auditUserAction: mocks.auditUserAction }));
vi.mock("@/lib/device-session", () => ({ deviceApprover: mocks.deviceApprover }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => null) }));
vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }));
vi.mock("@/lib/polar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polar")>()),
  loggablePolarError: (error: unknown) => error,
}));
vi.mock("@/lib/integrations/google", () => ({
  authorizationUrl: vi.fn(),
  browserCookie: vi.fn(),
  googleConfig: vi.fn(),
}));
vi.mock("@/lib/approvals/store", () => ({
  ApprovalError: class ApprovalError extends Error {
    constructor(
      readonly status: number,
      message: string
    ) {
      super(message);
    }
  },
  decideApproval: mocks.decideApproval,
  reopenBrowserApproval: vi.fn(),
  withdrawApproval: vi.fn(),
}));

const { POST } = await import("./route");

const TEAM = "00000000-0000-4000-8000-000000000001";

function approve() {
  return new Request("https://webhooks.cc/api/approvals/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "ABCD-EFGH", decision: "approve" }),
  });
}

function auditedActions(): Array<{ action: string; status: number; metadata?: unknown }> {
  return mocks.auditUserAction.mock.calls.map((call) => call[2]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deviceApprover.mockResolvedValue({ userId: "owner" });
});

describe("POST /api/approvals/decide", () => {
  test("a share link made on approval writes request.share_created", async () => {
    mocks.decideApproval.mockResolvedValue({
      id: "appr_1",
      action: "request_shares.create",
      done: true,
      result: { id: "share_1", url: "https://webhooks.cc/s/x" },
      params: { expiresInDays: 7 },
    });
    const response = await POST(approve());
    expect(await response.json()).toEqual({ status: "done" });
    expect(auditedActions()).toContainEqual(
      expect.objectContaining({
        action: "request.share_created",
        status: 200,
        targetId: "share_1",
        metadata: { approvalId: "appr_1", expiresInDays: 7 },
      })
    );
  });

  test("a checkout's link goes to this browser only, from what was never stored", async () => {
    mocks.decideApproval.mockResolvedValue({
      id: "appr_2",
      action: "billing.change",
      done: true,
      result: { executed: true, applied: "checkout", checkout: "opened" },
      params: { teamId: null, change: { kind: "capacity", capacity: { action: "buy_blocks" } } },
      forBrowser: { checkoutUrl: "https://polar.test/checkout/1" },
    });
    const response = await POST(approve());
    expect(await response.json()).toEqual({
      status: "redirect",
      url: "https://polar.test/checkout/1",
    });
  });

  test("an outcome unknown after Polar was asked is audited as 500 with the approval id", async () => {
    mocks.decideApproval.mockResolvedValue({
      id: "appr_3",
      action: "billing.change",
      done: true,
      result: { executed: null, code: "outcome_unknown", reason: "Check billing." },
      params: { teamId: TEAM, change: { kind: "seats", seats: 5 } },
    });
    const response = await POST(approve());
    expect(await response.json()).toEqual({ status: "unknown", reason: "Check billing." });
    expect(auditedActions()).toContainEqual(
      expect.objectContaining({
        action: "team.seats_changed",
        status: 500,
        reason: "Check billing.",
        teamId: TEAM,
        metadata: expect.objectContaining({ approvalId: "appr_3", code: "outcome_unknown" }),
      })
    );
  });

  test("a refusal on a fresh quote answers unchanged and audits 409", async () => {
    mocks.decideApproval.mockResolvedValue({
      id: "appr_4",
      action: "billing.change",
      done: true,
      result: { executed: false, code: "quote_changed", reason: "Nothing was changed: moved." },
      params: { teamId: null, change: { kind: "cancel" } },
    });
    const response = await POST(approve());
    expect(await response.json()).toEqual({
      status: "unchanged",
      reason: "Nothing was changed: moved.",
    });
    expect(auditedActions()).toContainEqual(
      expect.objectContaining({ action: "billing.subscription_canceled", status: 409 })
    );
  });

  test("a dropped seat reduction is made, with a note for the owner", async () => {
    mocks.decideApproval.mockResolvedValue({
      id: "appr_5",
      action: "billing.change",
      done: true,
      result: { executed: true, applied: "now", seatReductionLost: 3 },
      params: { teamId: TEAM, change: { kind: "keep_plan" } },
    });
    const response = await POST(approve());
    const body = await response.json();
    expect(body.status).toBe("done");
    expect(body.note).toMatch(/reduction to 3 seats was dropped/);
    expect(auditedActions()).toContainEqual(
      expect.objectContaining({
        action: "team.plan_kept",
        status: 200,
        metadata: expect.objectContaining({ seatReductionLost: 3 }),
      })
    );
  });
});
