import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({ createAdminClient: vi.fn() }));

vi.mock("./admin", () => ({ createAdminClient: mockFns.createAdminClient }));

import { TEAM_INACTIVE_MESSAGE, hasActiveTeamMembership, requireActiveTeam } from "./teams-gating";

// Minimal supabase-js select double: one queued response per table, plus a
// record of which tables were queried so short-circuits can be asserted.
interface QueryResult {
  data?: unknown;
  error?: unknown;
}

let queried: string[] = [];

function createFakeAdmin(responses: Record<string, QueryResult>) {
  return {
    from(table: string) {
      queried.push(table);

      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const method of ["select", "eq", "in", "not", "limit"] as const) {
        builder[method] = chain;
      }

      const settle = () => Promise.resolve({ data: null, error: null, ...responses[table] });
      builder.maybeSingle = settle;
      builder.then = (
        onFulfilled?: (value: QueryResult) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) => settle().then(onFulfilled, onRejected);

      return builder;
    },
  };
}

beforeEach(() => {
  queried = [];
  vi.clearAllMocks();
});

describe("requireActiveTeam", () => {
  test("passes a subscribed team", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ teams: { data: { subscription_status: "active" } } })
    );

    await expect(requireActiveTeam("team_1")).resolves.toBeNull();
  });

  test("rejects a team without a subscription", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ teams: { data: { subscription_status: null } } })
    );

    await expect(requireActiveTeam("team_1")).resolves.toBe(TEAM_INACTIVE_MESSAGE);
  });

  test("reports a missing team", async () => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ teams: { data: null } }));

    await expect(requireActiveTeam("team_1")).resolves.toBe("Team not found");
  });

  test("a past_due team is still usable", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ teams: { data: { subscription_status: "past_due" } } })
    );

    await expect(requireActiveTeam("team_1")).resolves.toBeNull();
  });
});

describe("hasActiveTeamMembership", () => {
  test("is true when one of the user's teams is subscribed", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        team_members: { data: [{ team_id: "team_1" }, { team_id: "team_2" }] },
        teams: { data: [{ id: "team_2" }] },
      })
    );

    await expect(hasActiveTeamMembership("user_1")).resolves.toBe(true);
  });

  test("is false when every team is unsubscribed", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        team_members: { data: [{ team_id: "team_1" }] },
        teams: { data: [] },
      })
    );

    await expect(hasActiveTeamMembership("user_1")).resolves.toBe(false);
  });

  test("skips the team lookup for a user with no memberships", async () => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ team_members: { data: [] } }));

    await expect(hasActiveTeamMembership("user_1")).resolves.toBe(false);
    expect(queried).toEqual(["team_members"]);
  });
});
