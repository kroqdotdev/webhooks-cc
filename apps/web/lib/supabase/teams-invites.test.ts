import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  assignTeamSeat: vi.fn(),
  revokeTeamSeat: vi.fn(),
  requireActiveTeam: vi.fn(),
}));

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

vi.mock("./team-billing", () => ({
  assignTeamSeat: mockFns.assignTeamSeat,
  revokeTeamSeat: mockFns.revokeTeamSeat,
}));

vi.mock("./teams-gating", () => ({
  requireActiveTeam: mockFns.requireActiveTeam,
  TEAM_INACTIVE_MESSAGE: "This team needs an active Teams subscription",
}));

import { acceptInvite, createInvite } from "./teams-invites";

// ---------------------------------------------------------------------------
// Minimal supabase-js query-builder double (same shape as teams-crud.test.ts,
// plus `count` for head-only counting selects).
// Responses are queued per `${table}:${operation}` and consumed in call order.
// ---------------------------------------------------------------------------

interface QueryResult {
  data?: unknown;
  error?: unknown;
  count?: number;
}

function createFakeAdmin(responses: Record<string, QueryResult[]>, rpcResult?: unknown) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: rpcResult, error: null }),
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

const NO_SEATS = "Team has no available seats — ask the owner to add seats";
const INACTIVE = "This team needs an active Teams subscription";

const PENDING_INVITE: QueryResult = {
  data: { team_id: "team_1", invited_email: "member@example.com" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFns.requireActiveTeam.mockResolvedValue(null);
  mockFns.assignTeamSeat.mockResolvedValue(null);
  mockFns.revokeTeamSeat.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acceptInvite", () => {
  test("assigns a Polar seat before claiming the invite and hands the id to the RPC", async () => {
    mockFns.assignTeamSeat.mockResolvedValue("seat_1");
    const admin = createFakeAdmin(
      {
        "team_invites:select": [PENDING_INVITE],
        "team_members:select": [{ data: null }],
      },
      { status: "accepted" }
    );
    mockFns.createAdminClient.mockReturnValue(admin);

    await expect(acceptInvite("user_1", "invite_1")).resolves.toEqual({ accepted: true });

    expect(mockFns.assignTeamSeat).toHaveBeenCalledWith("team_1", "member@example.com", "user_1");
    expect(admin.rpc).toHaveBeenCalledWith("accept_team_invite", {
      p_user_id: "user_1",
      p_invite_id: "invite_1",
      p_seat_id: "seat_1",
    });
    // The seat must exist before the membership row does.
    expect(mockFns.assignTeamSeat.mock.invocationCallOrder[0]).toBeLessThan(
      admin.rpc.mock.invocationCallOrder[0]
    );
    expect(mockFns.revokeTeamSeat).not.toHaveBeenCalled();
  });

  test("releases the seat it just assigned when the team turns out to be full", async () => {
    mockFns.assignTeamSeat.mockResolvedValue("seat_1");
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin(
        {
          "team_invites:select": [PENDING_INVITE],
          "team_members:select": [{ data: null }],
        },
        { status: "full" }
      )
    );

    await expect(acceptInvite("user_1", "invite_1")).resolves.toEqual({
      accepted: false,
      error: NO_SEATS,
    });
    expect(mockFns.revokeTeamSeat).toHaveBeenCalledWith("team_1", "seat_1", "member@example.com");
  });

  test("releases the seat and reports the subscription error when the team is inactive", async () => {
    mockFns.assignTeamSeat.mockResolvedValue("seat_2");
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin(
        {
          "team_invites:select": [PENDING_INVITE],
          "team_members:select": [{ data: null }],
        },
        { status: "inactive" }
      )
    );

    await expect(acceptInvite("user_1", "invite_1")).resolves.toEqual({
      accepted: false,
      error: INACTIVE,
    });
    expect(mockFns.revokeTeamSeat).toHaveBeenCalledWith("team_1", "seat_2", "member@example.com");
  });

  test("releases the seat when the invite is claimed out from under the accept", async () => {
    mockFns.assignTeamSeat.mockResolvedValue("seat_3");
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin(
        {
          "team_invites:select": [PENDING_INVITE],
          "team_members:select": [{ data: null }],
        },
        { status: "not_found" }
      )
    );

    await expect(acceptInvite("user_1", "invite_1")).resolves.toEqual({ accepted: false });
    expect(mockFns.revokeTeamSeat).toHaveBeenCalledWith("team_1", "seat_3", "member@example.com");
  });

  test("releases the seat and rethrows when the accept RPC throws", async () => {
    mockFns.assignTeamSeat.mockResolvedValue("seat_4");
    const admin = createFakeAdmin({
      "team_invites:select": [PENDING_INVITE],
      "team_members:select": [{ data: null }],
    });
    const timeout = new Error("canceling statement due to statement timeout");
    admin.rpc.mockRejectedValue(timeout);
    mockFns.createAdminClient.mockReturnValue(admin);

    // Nothing downstream would ever reference this seat: the invite is still
    // pending and no membership row was written.
    await expect(acceptInvite("user_1", "invite_1")).rejects.toBe(timeout);
    expect(mockFns.revokeTeamSeat).toHaveBeenCalledWith("team_1", "seat_4", "member@example.com");
  });

  test("releases the seat and rethrows when the accept RPC returns a database error", async () => {
    mockFns.assignTeamSeat.mockResolvedValue("seat_5");
    const admin = createFakeAdmin({
      "team_invites:select": [PENDING_INVITE],
      "team_members:select": [{ data: null }],
    });
    const dbError = { code: "57014", message: "canceling statement" };
    admin.rpc.mockResolvedValue({ data: null, error: dbError });
    mockFns.createAdminClient.mockReturnValue(admin);

    await expect(acceptInvite("user_1", "invite_1")).rejects.toBe(dbError);
    expect(mockFns.revokeTeamSeat).toHaveBeenCalledWith("team_1", "seat_5", "member@example.com");
  });

  test("does not revoke when the accept RPC fails with no seat assigned", async () => {
    const admin = createFakeAdmin({
      "team_invites:select": [PENDING_INVITE],
      "team_members:select": [{ data: null }],
    });
    const failure = new Error("pool exhausted");
    admin.rpc.mockRejectedValue(failure);
    mockFns.createAdminClient.mockReturnValue(admin);

    await expect(acceptInvite("user_1", "invite_1")).rejects.toBe(failure);
    expect(mockFns.revokeTeamSeat).not.toHaveBeenCalled();
  });

  test("does not revoke by email when no seat was assigned", async () => {
    // Unsubscribed team: assignTeamSeat returns null. A revoke call here would
    // fall back to an email lookup and could strip an unrelated seat.
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin(
        {
          "team_invites:select": [PENDING_INVITE],
          "team_members:select": [{ data: null }],
        },
        { status: "inactive" }
      )
    );

    await expect(acceptInvite("user_1", "invite_1")).resolves.toEqual({
      accepted: false,
      error: INACTIVE,
    });
    expect(mockFns.revokeTeamSeat).not.toHaveBeenCalled();
  });

  test("skips seat assignment when the user is already a member of the team", async () => {
    const admin = createFakeAdmin(
      {
        "team_invites:select": [PENDING_INVITE],
        "team_members:select": [{ data: { id: "member_1" } }],
      },
      { status: "accepted" }
    );
    mockFns.createAdminClient.mockReturnValue(admin);

    await expect(acceptInvite("user_1", "invite_1")).resolves.toEqual({ accepted: true });

    expect(mockFns.assignTeamSeat).not.toHaveBeenCalled();
    expect(admin.rpc).toHaveBeenCalledWith("accept_team_invite", {
      p_user_id: "user_1",
      p_invite_id: "invite_1",
      p_seat_id: null,
    });
  });

  test("spends no seat when the invite is not pending for this user", async () => {
    const admin = createFakeAdmin({ "team_invites:select": [{ data: null }] });
    mockFns.createAdminClient.mockReturnValue(admin);

    await expect(acceptInvite("user_1", "invite_1")).resolves.toEqual({ accepted: false });
    expect(mockFns.assignTeamSeat).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});

describe("createInvite", () => {
  const OWNER: QueryResult = { data: { role: "owner" } };

  test("refuses to invite into a team with no subscription", async () => {
    mockFns.requireActiveTeam.mockResolvedValue(INACTIVE);
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "team_members:select": [OWNER] }));

    await expect(createInvite("user_1", "team_1", "new@example.com")).resolves.toEqual({
      error: INACTIVE,
    });
    expect(mockFns.requireActiveTeam).toHaveBeenCalledWith("team_1");
  });

  test("refuses to invite when members already fill every purchased seat", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER, { count: 3 }],
        "teams:select": [{ data: { seats: 3 } }],
      })
    );

    await expect(createInvite("user_1", "team_1", "new@example.com")).resolves.toEqual({
      error: NO_SEATS,
    });
  });

  test("allows the invite while a seat is free", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER, { count: 2 }, { data: null }],
        "teams:select": [{ data: { seats: 3 } }, { data: { name: "Acme" } }],
        "users:select": [
          { data: { id: "user_2", email: "new@example.com" } },
          { data: { email: "owner@example.com" } },
        ],
        "team_invites:insert": [
          {
            data: {
              id: "invite_1",
              team_id: "team_1",
              invited_by: "user_1",
              invited_email: "new@example.com",
              invited_user_id: "user_2",
              status: "pending",
              created_at: "2026-01-01T00:00:00Z",
            },
          },
        ],
      })
    );

    const result = await createInvite("user_1", "team_1", "new@example.com");

    expect(result.error).toBeUndefined();
    expect(result.invite).toMatchObject({
      id: "invite_1",
      teamId: "team_1",
      teamName: "Acme",
      invitedEmail: "new@example.com",
      status: "pending",
    });
  });
});
