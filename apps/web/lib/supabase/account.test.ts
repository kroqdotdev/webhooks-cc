import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  revoke: vi.fn(),
  livePlanSubscriptions: vi.fn(),
  recordRefund: vi.fn(),
  revokeAllAddons: vi.fn(),
  deleteUser: vi.fn(),
  user: null as { polar_subscription_id: string | null; polar_customer_id: string | null } | null,
}));

vi.mock("@/lib/polar", () => ({
  createPolarClient: () => ({ subscriptions: { revoke: mockFns.revoke } }),
  isEndedSubscriptionError: () => false,
}));
vi.mock("./billing", () => ({ livePlanSubscriptions: mockFns.livePlanSubscriptions }));
vi.mock("@/lib/billing/refunds", () => ({ recordRefund: mockFns.recordRefund }));
vi.mock("./capacity-billing", () => ({ revokeAllAddons: mockFns.revokeAllAddons }));
vi.mock("./team-billing", () => ({ revokeTeamSubscription: vi.fn() }));
vi.mock("@/lib/tunnels/access", () => ({ closeRunsWithoutAccess: vi.fn() }));
vi.mock("@/lib/tunnels/names", () => ({ stopSharesUnderTeamNames: vi.fn() }));

// A query builder that answers every read with no rows, and the users row
// with the account the test sets.
vi.mock("./admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "delete"]) builder[method] = () => builder;
      builder.maybeSingle = async () => ({
        data: table === "users" ? mockFns.user : null,
        error: null,
      });
      builder.then = (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(onFulfilled);
      return builder;
    },
    auth: { admin: { deleteUser: mockFns.deleteUser } },
  }),
}));

import { AccountDeletionBillingError, deleteAccountForUser } from "./account";

beforeEach(() => {
  vi.clearAllMocks();
  mockFns.user = { polar_subscription_id: "sub_held", polar_customer_id: "cus_1" };
  mockFns.livePlanSubscriptions.mockResolvedValue([]);
  mockFns.deleteUser.mockResolvedValue({ error: null });
});

describe("deleteAccountForUser revokes every live plan subscription", () => {
  test("other live plan subscriptions are refunded and revoked, then the held one", async () => {
    mockFns.livePlanSubscriptions.mockResolvedValue([{ id: "sub_extra" }, { id: "sub_lost" }]);

    await deleteAccountForUser("user_1");

    expect(mockFns.livePlanSubscriptions).toHaveBeenCalledWith("cus_1", "sub_held");
    expect(mockFns.recordRefund.mock.calls).toEqual([
      [{ target: { subscription: "sub_extra" }, reason: "duplicate_plan", userId: "user_1" }],
      [{ target: { subscription: "sub_lost" }, reason: "duplicate_plan", userId: "user_1" }],
    ]);
    expect(mockFns.revoke.mock.calls).toEqual([["sub_extra"], ["sub_lost"], ["sub_held"]]);
    // Each refund is recorded before its revoke.
    expect(mockFns.recordRefund.mock.invocationCallOrder[0]).toBeLessThan(
      mockFns.revoke.mock.invocationCallOrder[0]
    );
    expect(mockFns.recordRefund.mock.invocationCallOrder[1]).toBeLessThan(
      mockFns.revoke.mock.invocationCallOrder[1]
    );
    // The held plan was used: no refund for it.
    expect(mockFns.recordRefund).toHaveBeenCalledTimes(2);
    expect(mockFns.deleteUser).toHaveBeenCalledWith("user_1");
  });

  test("a live plan with nothing stored on the row is still found and revoked", async () => {
    mockFns.user = { polar_subscription_id: null, polar_customer_id: "cus_1" };
    mockFns.livePlanSubscriptions.mockResolvedValue([{ id: "sub_lost" }]);

    await deleteAccountForUser("user_1");

    expect(mockFns.livePlanSubscriptions).toHaveBeenCalledWith("cus_1", null);
    expect(mockFns.revoke.mock.calls).toEqual([["sub_lost"]]);
  });

  test("a failed Polar list keeps the account", async () => {
    mockFns.livePlanSubscriptions.mockRejectedValue(new Error("Polar unavailable"));

    await expect(deleteAccountForUser("user_1")).rejects.toBeInstanceOf(
      AccountDeletionBillingError
    );
    expect(mockFns.revoke).not.toHaveBeenCalled();
    expect(mockFns.deleteUser).not.toHaveBeenCalled();
  });

  test("a failed refund record revokes nothing and keeps the account", async () => {
    mockFns.livePlanSubscriptions.mockResolvedValue([{ id: "sub_extra" }]);
    mockFns.recordRefund.mockRejectedValue(new Error("insert failed"));

    await expect(deleteAccountForUser("user_1")).rejects.toBeInstanceOf(
      AccountDeletionBillingError
    );
    expect(mockFns.revoke).not.toHaveBeenCalled();
    expect(mockFns.deleteUser).not.toHaveBeenCalled();
  });
});
