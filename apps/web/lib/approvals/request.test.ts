import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reportError: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }));
vi.mock("@/lib/audit", () => ({ auditUserAction: vi.fn() }));
vi.mock("@/lib/email/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/polar", () => ({
  // Stands in for the real one: a Polar error comes back without its body.
  loggablePolarError: (error: unknown) => ({ name: "PolarError", detail: "scrubbed", error }),
}));
vi.mock("./actions", () => ({ actionSpec: () => ({ parse: mocks.parse }) }));
vi.mock("./store", () => ({
  ApprovalError: class ApprovalError extends Error {},
  approvalEmailRecipient: vi.fn(),
  createApproval: vi.fn(),
}));

const { requestApproval } = await import("./request");

describe("asking for an approval", () => {
  test("a failure while quoting is reported through loggablePolarError, never raw", async () => {
    const raw = new Error('{"detail":"customer jane@example.com not found"}');
    mocks.parse.mockRejectedValueOnce(raw);
    const response = await requestApproval(
      new Request("https://webhooks.cc/api/billing", { method: "POST" }),
      { userId: "owner", keyId: "key-1" },
      "billing.change",
      {}
    );
    expect(response.status).toBe(500);
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    const [, reported] = mocks.reportError.mock.calls[0];
    expect(reported).toMatchObject({ name: "PolarError", detail: "scrubbed" });
    expect(reported).not.toBe(raw);
  });
});
