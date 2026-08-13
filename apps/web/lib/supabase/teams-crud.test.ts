import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  revokeTeamSubscription: vi.fn(),
}));

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

vi.mock("./team-billing", () => ({
  revokeTeamSubscription: mockFns.revokeTeamSubscription,
}));

import { createTeam, deleteTeam, listTeamsForUser } from "./teams-crud";

// ---------------------------------------------------------------------------
// Minimal supabase-js query-builder double (same shape as team-billing.test.ts).
// Responses are queued per `${table}:${operation}` and consumed in call order.
// ---------------------------------------------------------------------------

interface QueryResult {
  data?: unknown;
  error?: unknown;
}

let recorded: string[] = [];

function createFakeAdmin(responses: Record<string, QueryResult[]>, rpcResult?: unknown) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: rpcResult, error: null }),
    from(table: string) {
      let op = "select";

      const take = (): QueryResult => {
        recorded.push(`${table}:${op}`);
        const queue = responses[`${table}:${op}`];
        return { data: null, error: null, ...queue?.shift() };
      };

      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["eq", "is", "not", "in", "order", "limit", "select"] as const) {
        builder[method] = chain;
      }

      for (const method of ["insert", "update", "delete"] as const) {
        builder[method] = () => {
          op = method;
          return builder;
        };
      }

      const settle = () => Promise.resolve(take());

      builder.maybeSingle = settle;
      builder.single = settle;
      builder.then = (
        onFulfilled?: (value: QueryResult) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) => settle().then(onFulfilled, onRejected);

      return builder;
    },
  };
}

const OWNER_MEMBERSHIP: QueryResult = { data: { role: "owner" } };

beforeEach(() => {
  recorded = [];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTeam", () => {
  test("creates a suspended, seatless team without checking the caller's plan", async () => {
    const admin = createFakeAdmin(
      {},
      { id: "team_1", name: "Acme", created_by: "user_1", created_at: "2026-01-01T00:00:00Z" }
    );
    mockFns.createAdminClient.mockReturnValue(admin);

    const result = await createTeam("user_1", "Acme");

    expect(result).toMatchObject({
      id: "team_1",
      name: "Acme",
      role: "owner",
      memberCount: 1,
      suspended: true,
      subscriptionStatus: null,
      seats: 0,
      requestsUsed: 0,
      requestLimit: 0,
      periodEnd: null,
      cancelAtPeriodEnd: false,
    });
    expect(admin.rpc).toHaveBeenCalledWith("create_team_with_owner", {
      p_user_id: "user_1",
      p_name: "Acme",
    });
  });
});

describe("listTeamsForUser", () => {
  test("maps billing state and leaves an unsubscribed period end null", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [
          { data: [{ team_id: "team_1", role: "owner" }] },
          { data: [{ team_id: "team_1" }, { team_id: "team_1" }] },
        ],
        "teams:select": [
          {
            data: [
              {
                id: "team_1",
                name: "Acme",
                created_by: "user_1",
                created_at: "2026-01-01T00:00:00Z",
                subscription_status: null,
                seats: 0,
                requests_used: 0,
                request_limit: 0,
                period_end: null,
                cancel_at_period_end: false,
              },
            ],
          },
        ],
      })
    );

    const [team] = await listTeamsForUser("user_1");

    expect(team).toMatchObject({
      id: "team_1",
      memberCount: 2,
      role: "owner",
      suspended: true,
      subscriptionStatus: null,
      periodEnd: null,
    });
  });

  test("reports a subscribed team as active with its seat allowance", async () => {
    const periodEnd = "2026-09-01T00:00:00Z";
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [
          { data: [{ team_id: "team_1", role: "member" }] },
          { data: [{ team_id: "team_1" }] },
        ],
        "teams:select": [
          {
            data: [
              {
                id: "team_1",
                name: "Acme",
                created_by: "user_1",
                created_at: "2026-01-01T00:00:00Z",
                subscription_status: "active",
                seats: 3,
                requests_used: 42,
                request_limit: 300_000,
                period_end: periodEnd,
                cancel_at_period_end: true,
              },
            ],
          },
        ],
      })
    );

    const [team] = await listTeamsForUser("user_2");

    expect(team).toMatchObject({
      role: "member",
      suspended: false,
      subscriptionStatus: "active",
      seats: 3,
      requestsUsed: 42,
      requestLimit: 300_000,
      periodEnd: Date.parse(periodEnd),
      cancelAtPeriodEnd: true,
    });
  });
});

describe("deleteTeam", () => {
  test("revokes the Polar subscription before deleting the team", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [{ data: { polar_subscription_id: "sub_123" } }],
        "teams:delete": [{ data: { id: "team_1" } }],
      })
    );
    mockFns.revokeTeamSubscription.mockImplementation(() => {
      // The delete must not have run yet: once the row is gone, a failed
      // revoke would leave an orphaned subscription with no stored id.
      expect(recorded).not.toContain("teams:delete");
      return Promise.resolve();
    });

    await expect(deleteTeam("user_1", "team_1")).resolves.toBe(true);
    expect(mockFns.revokeTeamSubscription).toHaveBeenCalledWith("sub_123");
    expect(recorded).toContain("teams:delete");
  });

  test("skips the revoke when the team never subscribed", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [{ data: { polar_subscription_id: null } }],
        "teams:delete": [{ data: { id: "team_1" } }],
      })
    );

    await expect(deleteTeam("user_1", "team_1")).resolves.toBe(true);
    expect(mockFns.revokeTeamSubscription).not.toHaveBeenCalled();
  });

  test("aborts the deletion when the revoke fails, so the owner can retry", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [{ data: { polar_subscription_id: "sub_123" } }],
        "teams:delete": [{ data: { id: "team_1" } }],
      })
    );
    mockFns.revokeTeamSubscription.mockRejectedValue(new Error("polar down"));

    await expect(deleteTeam("user_1", "team_1")).rejects.toThrow("polar down");
    expect(recorded).not.toContain("teams:delete");
  });

  test("does not touch Polar when the caller is not the owner", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "team_members:select": [{ data: null }] })
    );

    await expect(deleteTeam("user_2", "team_1")).resolves.toBe(false);
    expect(mockFns.revokeTeamSubscription).not.toHaveBeenCalled();
  });
});
