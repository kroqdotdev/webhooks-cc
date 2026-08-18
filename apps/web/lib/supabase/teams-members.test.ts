import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  revokeTeamSeat: vi.fn(),
  removeMemberShares: vi.fn(),
}));

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

vi.mock("./team-billing", () => ({
  revokeTeamSeat: mockFns.revokeTeamSeat,
}));

vi.mock("./teams-endpoints", () => ({
  removeMemberShares: mockFns.removeMemberShares,
}));

import { leaveTeam, removeTeamMember } from "./teams-members";

// ---------------------------------------------------------------------------
// Minimal supabase-js query-builder double (same shape as teams-crud.test.ts).
// Responses are queued per `${table}:${operation}` and consumed in call order.
// ---------------------------------------------------------------------------

interface QueryResult {
  data?: unknown;
  error?: unknown;
}

function createFakeAdmin(responses: Record<string, QueryResult[]>) {
  return {
    from(table: string) {
      let op = "select";

      const take = (): QueryResult => {
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
const MEMBER_MEMBERSHIP: QueryResult = { data: { role: "member" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockFns.revokeTeamSeat.mockResolvedValue(undefined);
  mockFns.removeMemberShares.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("removeTeamMember", () => {
  test("releases the removed member's Polar seat", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "team_members:delete": [{ data: { id: "member_1", polar_seat_id: "seat_1" } }],
        "users:select": [{ data: { email: "member@example.com" } }],
      })
    );

    await expect(removeTeamMember("user_1", "team_1", "user_2")).resolves.toBe(true);
    expect(mockFns.revokeTeamSeat).toHaveBeenCalledWith("team_1", "seat_1", "member@example.com");
    // The departed member's endpoint shares stop billing the team pool.
    expect(mockFns.removeMemberShares).toHaveBeenCalledWith("team_1", "user_2");
  });

  test("still releases by email when the membership has no recorded seat", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "team_members:delete": [{ data: { id: "member_1", polar_seat_id: null } }],
        "users:select": [{ data: { email: "member@example.com" } }],
      })
    );

    await expect(removeTeamMember("user_1", "team_1", "user_2")).resolves.toBe(true);
    expect(mockFns.revokeTeamSeat).toHaveBeenCalledWith("team_1", null, "member@example.com");
  });

  test("still releases the seat and reports success when the email lookup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "team_members:delete": [{ data: { id: "member_1", polar_seat_id: "seat_1" } }],
        "users:select": [{ error: new Error("db down") }],
      })
    );

    // The membership row is already gone; the lookup failure must not turn a
    // committed removal into an error, and the known seat id must still be
    // released (the email is only revokeTeamSeat's fallback lookup key).
    await expect(removeTeamMember("user_1", "team_1", "user_2")).resolves.toBe(true);
    expect(mockFns.revokeTeamSeat).toHaveBeenCalledWith("team_1", "seat_1", "");
    expect(consoleError).toHaveBeenCalled();
  });

  test("touches no seat when the target was not a member", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "team_members:delete": [{ data: null }],
      })
    );

    await expect(removeTeamMember("user_1", "team_1", "user_2")).resolves.toBe(false);
    expect(mockFns.revokeTeamSeat).not.toHaveBeenCalled();
    expect(mockFns.removeMemberShares).not.toHaveBeenCalled();
  });

  test("touches no seat when the caller is not the owner", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "team_members:select": [{ data: null }] })
    );

    await expect(removeTeamMember("user_1", "team_1", "user_2")).resolves.toBe(false);
    expect(mockFns.revokeTeamSeat).not.toHaveBeenCalled();
  });
});

describe("leaveTeam", () => {
  test("releases the leaving member's Polar seat", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [MEMBER_MEMBERSHIP],
        "team_members:delete": [{ data: { id: "member_1", polar_seat_id: "seat_9" } }],
        "users:select": [{ data: { email: "leaver@example.com" } }],
      })
    );

    await expect(leaveTeam("user_2", "team_1")).resolves.toBe(true);
    expect(mockFns.revokeTeamSeat).toHaveBeenCalledWith("team_1", "seat_9", "leaver@example.com");
    expect(mockFns.removeMemberShares).toHaveBeenCalledWith("team_1", "user_2");
  });

  test("keeps the owner's seat when they try to leave", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "team_members:select": [OWNER_MEMBERSHIP] })
    );

    await expect(leaveTeam("user_1", "team_1")).resolves.toBe(false);
    expect(mockFns.revokeTeamSeat).not.toHaveBeenCalled();
    expect(mockFns.removeMemberShares).not.toHaveBeenCalled();
  });
});
