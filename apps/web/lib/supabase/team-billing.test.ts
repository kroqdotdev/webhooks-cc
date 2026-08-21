import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  createPolarClient: vi.fn(),
  getPolarTeamsCheckoutConfig: vi.fn(),
}));

vi.mock("@/lib/polar", () => ({
  createPolarClient: mockFns.createPolarClient,
  getPolarTeamsCheckoutConfig: mockFns.getPolarTeamsCheckoutConfig,
  loggablePolarError: (error: unknown) => error,
  unwrapPolarResult: <T>(result: T) => result,
}));

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

import {
  TeamBillingError,
  applyTeamPolarWebhookEvent,
  assignTeamSeat,
  cancelTeamSubscription,
  createTeamCheckout,
  extractTeamIdFromWebhook,
  resubscribeTeam,
  revokeTeamSeat,
  revokeTeamSubscription,
  updateTeamSeats,
} from "./team-billing";

// ---------------------------------------------------------------------------
// Minimal supabase-js query-builder double.
//
// Responses are queued per `${table}:${operation}` and consumed in call order,
// so a function that hits the same table twice (owner check, then member count)
// gets each queued response in turn. Anything unscripted resolves empty.
// ---------------------------------------------------------------------------

interface QueryResult {
  data?: unknown;
  error?: unknown;
  count?: number;
}

interface RecordedCall {
  table: string;
  op: string;
  payload?: unknown;
}

interface RecordedFilterCall {
  table: string;
  op: string;
  filters: Array<[string, string, unknown]>;
}

let recorded: RecordedCall[] = [];
// eq/is filters per query, kept out of `recorded` so exact-equality assertions
// on it keep working.
let recordedFilters: RecordedFilterCall[] = [];

function createFakeAdmin(responses: Record<string, QueryResult[]>) {
  return {
    rpc(name: string, params?: unknown) {
      recorded.push({ table: `rpc:${name}`, op: "rpc", payload: params });
      const queue = responses[`rpc:${name}`];
      const next = queue?.shift();
      return Promise.resolve({ data: null, error: null, ...next });
    },
    from(table: string) {
      let op = "select";
      let payload: unknown;
      const filters: Array<[string, string, unknown]> = [];

      const take = (): QueryResult => {
        const queue = responses[`${table}:${op}`];
        const next = queue?.shift();
        return { data: null, error: null, count: 0, ...next };
      };

      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["in", "order", "limit", "select"] as const) {
        builder[method] = chain;
      }

      for (const method of ["eq", "is"] as const) {
        builder[method] = (field: string, value: unknown) => {
          filters.push([method, field, value]);
          return builder;
        };
      }

      builder.or = (expression: string) => {
        filters.push(["or", expression, null]);
        return builder;
      };

      for (const method of ["insert", "update", "delete"] as const) {
        builder[method] = (value?: unknown) => {
          op = method;
          payload = value;
          return builder;
        };
      }

      const settle = () => {
        recorded.push({ table, op, payload });
        recordedFilters.push({ table, op, filters: [...filters] });
        return Promise.resolve(take());
      };

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

function teamRow(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: "team_1",
      name: "Acme",
      created_by: "user_1",
      polar_customer_id: null,
      polar_subscription_id: null,
      subscription_status: null,
      seats: 0,
      cancel_at_period_end: false,
      ...overrides,
    },
  };
}

beforeEach(() => {
  recorded = [];
  recordedFilters = [];
  vi.clearAllMocks();
  mockFns.getPolarTeamsCheckoutConfig.mockReturnValue({
    appUrl: "https://webhooks.cc",
    teamsProductId: "prod_teams_123",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createTeamCheckout", () => {
  test("rejects a seat count below one before touching the database", async () => {
    await expect(createTeamCheckout("user_1", "team_1", 0)).rejects.toMatchObject({
      name: "TeamBillingError",
      code: "invalid_seats",
    });

    expect(mockFns.createAdminClient).not.toHaveBeenCalled();
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("rejects a fractional seat count", async () => {
    await expect(createTeamCheckout("user_1", "team_1", 2.5)).rejects.toMatchObject({
      code: "invalid_seats",
    });
  });

  test("rejects a caller who is not the team owner", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "team_members:select": [{ data: null }] })
    );

    await expect(createTeamCheckout("user_2", "team_1", 5)).rejects.toMatchObject({
      code: "not_owner",
    });

    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("rejects a team that already carries a subscription", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ subscription_status: "past_due" })],
      })
    );

    await expect(createTeamCheckout("user_1", "team_1", 5)).rejects.toMatchObject({
      code: "already_subscribed",
    });

    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("rejects the checkout when the owner row is missing, instead of an empty billing email", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow()],
        "users:select": [{ data: null }],
        // Lease claim, then the lease release after the failure.
        "teams:update": [{ data: { id: "team_1" } }, {}],
      })
    );

    const customerCreate = vi.fn();
    mockFns.createPolarClient.mockReturnValue({ customers: { create: customerCreate } });

    await expect(createTeamCheckout("user_1", "team_1", 5)).rejects.toMatchObject({
      code: "owner_not_found",
    });

    expect(customerCreate).not.toHaveBeenCalled();
  });

  test("creates a team-scoped Polar customer and a seated checkout", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow()],
        "users:select": [{ data: { email: "owner@example.com", name: "Owner" } }],
        // Lease claim, customer-id write, session cache write.
        "teams:update": [{ data: { id: "team_1" } }, {}, {}],
      })
    );

    const customerCreate = vi.fn().mockResolvedValue({ id: "cus_team_1" });
    const checkoutCreate = vi
      .fn()
      .mockResolvedValue({ url: "https://sandbox.polar.sh/checkout/team" });
    mockFns.createPolarClient.mockReturnValue({
      customers: { create: customerCreate },
      checkouts: { create: checkoutCreate },
    });

    await expect(createTeamCheckout("user_1", "team_1", 5)).resolves.toBe(
      "https://sandbox.polar.sh/checkout/team"
    );

    // A `team`-type customer without an email of its own: Polar allows one
    // customer per email per organization, and the owner usually already is
    // one (personal Pro) or owns another team. The owner rides along as the
    // owner member, which is what Polar bills and emails.
    expect(customerCreate).toHaveBeenCalledWith({
      type: "team",
      name: "Acme",
      externalId: "team:team_1",
      metadata: { teamId: "team_1" },
      owner: { email: "owner@example.com", name: "Owner", externalId: "user_1" },
    });
    expect(checkoutCreate).toHaveBeenCalledWith({
      products: ["prod_teams_123"],
      seats: 5,
      successUrl: "https://webhooks.cc/teams/team_1?subscribed=true",
      customerId: "cus_team_1",
    });
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: { polar_customer_id: "cus_team_1" },
    });
    // The fresh session is cached for the reuse path (the lease claim also
    // writes pending_checkout, so match on the session's url).
    const cacheWrite = recorded.find(
      (call) =>
        call.table === "teams" &&
        call.op === "update" &&
        (
          (call.payload as Record<string, unknown>)?.pending_checkout as
            Record<string, unknown> | null | undefined
        )?.url != null
    );
    expect(cacheWrite).toBeDefined();
    expect((cacheWrite!.payload as Record<string, unknown>).pending_checkout).toMatchObject({
      url: "https://sandbox.polar.sh/checkout/team",
      seats: 5,
    });
    // The cache write is fenced on the lease token, so a stalled request that
    // lost its lease cannot overwrite a newer claimant's session.
    const cacheWriteIndex = recorded.indexOf(cacheWrite!);
    expect(
      recordedFilters[cacheWriteIndex].filters.some(
        (f) => f[0] === "eq" && f[1] === "pending_checkout->>created_at"
      )
    ).toBe(true);
  });

  test("reuses the cached checkout session for the same seat count within the TTL", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({
            pending_checkout: {
              id: "co_1",
              url: "https://sandbox.polar.sh/checkout/cached",
              seats: 5,
              created_at: new Date(Date.now() - 60_000).toISOString(),
            },
          }),
        ],
      })
    );

    await expect(createTeamCheckout("user_1", "team_1", 5)).resolves.toBe(
      "https://sandbox.polar.sh/checkout/cached"
    );
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("mints a fresh session when the requested seat count differs from the cached one", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({
            polar_customer_id: "cus_team_1",
            pending_checkout: {
              id: "co_1",
              url: "https://sandbox.polar.sh/checkout/cached",
              seats: 3,
              created_at: new Date(Date.now() - 60_000).toISOString(),
            },
          }),
        ],
        "teams:update": [{ data: { id: "team_1" } }, {}],
      })
    );

    const checkoutCreate = vi
      .fn()
      .mockResolvedValue({ id: "co_2", url: "https://sandbox.polar.sh/checkout/fresh" });
    mockFns.createPolarClient.mockReturnValue({ checkouts: { create: checkoutCreate } });

    await expect(createTeamCheckout("user_1", "team_1", 5)).resolves.toBe(
      "https://sandbox.polar.sh/checkout/fresh"
    );
    expect(checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({ seats: 5 }));
  });

  test("still returns the checkout URL when the cache write fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_customer_id: "cus_team_1" })],
        "teams:update": [{ data: { id: "team_1" } }, { error: new Error("db down") }],
      })
    );

    const checkoutCreate = vi
      .fn()
      .mockResolvedValue({ id: "co_9", url: "https://sandbox.polar.sh/checkout/uncached" });
    mockFns.createPolarClient.mockReturnValue({ checkouts: { create: checkoutCreate } });

    // The session exists in Polar either way; losing the dedup cache must not
    // fail the checkout.
    await expect(createTeamCheckout("user_1", "team_1", 5)).resolves.toBe(
      "https://sandbox.polar.sh/checkout/uncached"
    );
    expect(consoleError).toHaveBeenCalled();
  });

  test("reuses the session while Polar's expires_at is in the future, even past the created_at TTL", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({
            pending_checkout: {
              id: "co_1",
              url: "https://sandbox.polar.sh/checkout/cached",
              seats: 5,
              created_at: new Date(Date.now() - 45 * 60_000).toISOString(),
              expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
            },
          }),
        ],
      })
    );

    await expect(createTeamCheckout("user_1", "team_1", 5)).resolves.toBe(
      "https://sandbox.polar.sh/checkout/cached"
    );
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("mints a fresh session when Polar's expires_at has passed despite a recent created_at", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({
            polar_customer_id: "cus_team_1",
            pending_checkout: {
              id: "co_1",
              url: "https://sandbox.polar.sh/checkout/expired",
              seats: 5,
              created_at: new Date(Date.now() - 60_000).toISOString(),
              expires_at: new Date(Date.now() - 1_000).toISOString(),
            },
          }),
        ],
        "teams:update": [{ data: { id: "team_1" } }, {}],
      })
    );

    const checkoutCreate = vi
      .fn()
      .mockResolvedValue({ id: "co_4", url: "https://sandbox.polar.sh/checkout/fresh" });
    mockFns.createPolarClient.mockReturnValue({ checkouts: { create: checkoutCreate } });

    await expect(createTeamCheckout("user_1", "team_1", 5)).resolves.toBe(
      "https://sandbox.polar.sh/checkout/fresh"
    );
  });

  test("mints a fresh session when the cached one is past the TTL", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({
            polar_customer_id: "cus_team_1",
            pending_checkout: {
              id: "co_1",
              url: "https://sandbox.polar.sh/checkout/stale",
              seats: 5,
              created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
            },
          }),
        ],
        "teams:update": [{ data: { id: "team_1" } }, {}],
      })
    );

    const checkoutCreate = vi
      .fn()
      .mockResolvedValue({ id: "co_3", url: "https://sandbox.polar.sh/checkout/fresh" });
    mockFns.createPolarClient.mockReturnValue({ checkouts: { create: checkoutCreate } });

    await expect(createTeamCheckout("user_1", "team_1", 5)).resolves.toBe(
      "https://sandbox.polar.sh/checkout/fresh"
    );
  });

  test("returns the winner's session when the lease claim is lost and the session appeared", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow(),
          // Re-read after the lost claim: the concurrent winner finished.
          {
            data: {
              pending_checkout: {
                id: "co_w",
                url: "https://sandbox.polar.sh/checkout/winner",
                seats: 5,
                created_at: new Date(Date.now() - 5_000).toISOString(),
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              },
            },
          },
        ],
        "teams:update": [{ data: null }],
      })
    );

    await expect(createTeamCheckout("user_1", "team_1", 5)).resolves.toBe(
      "https://sandbox.polar.sh/checkout/winner"
    );
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("reports checkout_in_progress when another request is still minting", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow(),
          // Re-read after the lost claim: the winner is still creating.
          {
            data: {
              pending_checkout: {
                status: "creating",
                seats: 5,
                created_at: new Date(Date.now() - 2_000).toISOString(),
              },
            },
          },
        ],
        "teams:update": [{ data: null }],
      })
    );

    await expect(createTeamCheckout("user_1", "team_1", 5)).rejects.toMatchObject({
      code: "checkout_in_progress",
    });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("releases the lease when Polar rejects the checkout", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_customer_id: "cus_team_1" })],
        "teams:update": [{ data: { id: "team_1" } }, {}],
      })
    );

    const checkoutCreate = vi.fn().mockRejectedValue(new Error("polar down"));
    mockFns.createPolarClient.mockReturnValue({ checkouts: { create: checkoutCreate } });

    await expect(createTeamCheckout("user_1", "team_1", 5)).rejects.toThrow("polar down");

    // A retry must be able to mint immediately instead of waiting out the
    // lease TTL.
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: { pending_checkout: null },
    });
    // The release is fenced on the lease token: a stalled request that lost
    // its lease must not null a newer claimant's session.
    const releaseIndex = recorded.findIndex(
      (call) =>
        call.table === "teams" &&
        call.op === "update" &&
        (call.payload as Record<string, unknown>)?.pending_checkout === null
    );
    expect(
      recordedFilters[releaseIndex].filters.some(
        (f) => f[0] === "eq" && f[1] === "pending_checkout->>created_at"
      )
    ).toBe(true);
  });
});

describe("updateTeamSeats", () => {
  test("refuses to shrink the subscription below the current member count", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 5 })],
        "rpc:update_team_seats": [{ data: { status: "below_members", member_count: 4 } }],
      })
    );

    await expect(updateTeamSeats("user_1", "team_1", 3)).rejects.toMatchObject({
      code: "seats_below_members",
    });

    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("rejects a team without a subscription", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow()],
      })
    );

    await expect(updateTeamSeats("user_1", "team_1", 3)).rejects.toMatchObject({
      code: "no_subscription",
    });
  });

  test("reduction: writes the seat change through the locking RPC before calling Polar", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 6 })],
        "rpc:update_team_seats": [{ data: { status: "ok", previous_seats: 6 } }],
      })
    );

    const rpcWrite = {
      table: "rpc:update_team_seats",
      op: "rpc",
      payload: { p_team_id: "team_1", p_seats: 3 },
    };
    const subscriptionUpdate = vi.fn().mockImplementation(() => {
      // For a reduction the DB write must land before Polar is told: the RPC's
      // row lock is what serializes it against concurrent invite accepts.
      expect(recorded).toContainEqual(rpcWrite);
      return Promise.resolve({ id: "sub_1" });
    });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await updateTeamSeats("user_1", "team_1", 3);

    expect(subscriptionUpdate).toHaveBeenCalledWith({
      id: "sub_1",
      subscriptionUpdate: { seats: 3 },
    });
    expect(recorded).toContainEqual(rpcWrite);
  });

  test("increase: confirms with Polar before exposing capacity in the database", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 2 })],
        "rpc:update_team_seats": [{ data: { status: "ok", previous_seats: 2 } }],
      })
    );

    const rpcWrite = {
      table: "rpc:update_team_seats",
      op: "rpc",
      payload: { p_team_id: "team_1", p_seats: 6 },
    };
    const subscriptionUpdate = vi.fn().mockImplementation(() => {
      // For an increase the DB write must wait for Polar: a concurrent invite
      // accept must never fill capacity Polar has not confirmed.
      expect(recorded).not.toContainEqual(rpcWrite);
      return Promise.resolve({ id: "sub_1" });
    });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await updateTeamSeats("user_1", "team_1", 6);

    expect(subscriptionUpdate).toHaveBeenCalledWith({
      id: "sub_1",
      subscriptionUpdate: { seats: 6 },
    });
    expect(recorded).toContainEqual(rpcWrite);
  });

  test("increase: leaves the database untouched when Polar rejects the update", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 2 })],
      })
    );

    const subscriptionUpdate = vi.fn().mockRejectedValue(new Error("polar down"));
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await expect(updateTeamSeats("user_1", "team_1", 6)).rejects.toThrow("polar down");

    expect(recorded.filter((call) => call.table === "rpc:update_team_seats")).toEqual([]);
  });

  test("increase: surfaces a DB write failure after Polar accepted and logs it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 2 })],
        "rpc:update_team_seats": [{ data: { status: "not_found" } }],
      })
    );

    const subscriptionUpdate = vi.fn().mockResolvedValue({ id: "sub_1" });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await expect(updateTeamSeats("user_1", "team_1", 6)).rejects.toMatchObject({
      code: "seat_update_failed",
    });
    expect(consoleError).toHaveBeenCalled();
  });

  test("reduction: restores the previous seat count when Polar rejects the update", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 6 })],
        "rpc:update_team_seats": [
          { data: { status: "ok", previous_seats: 6 } },
          { data: { status: "ok", previous_seats: 3 } },
        ],
      })
    );

    const subscriptionUpdate = vi.fn().mockRejectedValue(new Error("polar down"));
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await expect(updateTeamSeats("user_1", "team_1", 3)).rejects.toThrow("polar down");

    expect(recorded).toContainEqual({
      table: "rpc:update_team_seats",
      op: "rpc",
      payload: { p_team_id: "team_1", p_seats: 6 },
    });
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("seat assignment", () => {
  test("returns null without calling Polar when the team has no subscription", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "teams:select": [{ data: { polar_subscription_id: null } }] })
    );

    await expect(assignTeamSeat("team_1", "member@example.com", "user_2")).resolves.toBeNull();
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("claims the seat immediately and tags it with the member", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "teams:select": [{ data: { polar_subscription_id: "sub_1" } }] })
    );

    const assignSeat = vi.fn().mockResolvedValue({ id: "seat_1" });
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { assignSeat } });

    await expect(assignTeamSeat("team_1", "member@example.com", "user_2")).resolves.toBe("seat_1");
    expect(assignSeat).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      email: "member@example.com",
      immediateClaim: true,
      metadata: { userId: "user_2", teamId: "team_1" },
    });
  });
});

describe("revokeTeamSeat", () => {
  test("looks the seat up by email when no seat id was stored", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "teams:select": [{ data: { polar_subscription_id: "sub_1" } }] })
    );

    const listSeats = vi.fn().mockResolvedValue({
      totalSeats: 3,
      availableSeats: 1,
      seats: [
        { id: "seat_old", status: "revoked", customerEmail: "member@example.com", email: null },
        { id: "seat_1", status: "claimed", customerEmail: "Member@Example.com", email: null },
      ],
    });
    const revokeSeat = vi.fn().mockResolvedValue({ id: "seat_1" });
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { listSeats, revokeSeat } });

    await revokeTeamSeat("team_1", null, "member@example.com");

    expect(listSeats).toHaveBeenCalledWith({ subscriptionId: "sub_1" });
    expect(revokeSeat).toHaveBeenCalledWith({ seatId: "seat_1" });
  });

  test("never calls Polar for a team without a subscription", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "teams:select": [{ data: { polar_subscription_id: null } }] })
    );

    await expect(revokeTeamSeat("team_1", "seat_1", "member@example.com")).resolves.toBeUndefined();
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("logs and swallows Polar failures — the membership is already gone", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "teams:select": [{ data: { polar_subscription_id: "sub_1" } }] })
    );

    const revokeSeat = vi.fn().mockRejectedValue(new Error("polar down"));
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { revokeSeat } });

    await expect(revokeTeamSeat("team_1", "seat_1", "member@example.com")).resolves.toBeUndefined();
    expect(revokeSeat).toHaveBeenCalledWith({ seatId: "seat_1" });
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("subscription management", () => {
  test("cancelTeamSubscription flags cancel-at-period-end in Polar, then the row", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({ polar_subscription_id: "sub_1", subscription_status: "active" }),
        ],
        "teams:update": [{}],
      })
    );

    const subscriptionUpdate = vi.fn().mockResolvedValue({ id: "sub_1" });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await cancelTeamSubscription("user_1", "team_1");

    expect(subscriptionUpdate).toHaveBeenCalledWith({
      id: "sub_1",
      subscriptionUpdate: { cancelAtPeriodEnd: true },
    });
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: { cancel_at_period_end: true },
    });
  });

  test("cancelTeamSubscription rejects a team without a subscription", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow()],
      })
    );

    await expect(cancelTeamSubscription("user_1", "team_1")).rejects.toMatchObject({
      code: "no_subscription",
    });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("resubscribeTeam rejects when no cancellation is scheduled", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({
            polar_subscription_id: "sub_1",
            subscription_status: "active",
            cancel_at_period_end: false,
          }),
        ],
      })
    );

    await expect(resubscribeTeam("user_1", "team_1")).rejects.toMatchObject({
      code: "not_scheduled",
    });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("resubscribeTeam clears the scheduled cancellation", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({
            polar_subscription_id: "sub_1",
            subscription_status: "canceled",
            cancel_at_period_end: true,
          }),
        ],
        "teams:update": [{}],
      })
    );

    const subscriptionUpdate = vi.fn().mockResolvedValue({ id: "sub_1" });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await resubscribeTeam("user_1", "team_1");

    expect(subscriptionUpdate).toHaveBeenCalledWith({
      id: "sub_1",
      subscriptionUpdate: { cancelAtPeriodEnd: false },
    });
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: { cancel_at_period_end: false },
    });
  });

  test("revokeTeamSubscription revokes the Polar subscription immediately", async () => {
    const revoke = vi.fn().mockResolvedValue({ id: "sub_1" });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { revoke } });

    await revokeTeamSubscription("sub_1");

    expect(revoke).toHaveBeenCalledWith({ id: "sub_1" });
  });
});

describe("webhook events for a deleted team", () => {
  // The team row is gone (deleted with, or after, its subscription): every
  // event family must no-op without throwing and without writing.
  const NO_TEAM: QueryResult = { data: null };

  test.each([
    "subscription.created",
    "subscription.updated",
    "subscription.active",
    "subscription.canceled",
    "subscription.uncanceled",
    "subscription.revoked",
  ])("%s no-ops without writes", async (eventType) => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [NO_TEAM] }));

    await applyTeamPolarWebhookEvent(eventType, "team_gone", {
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      seats: 2,
    });

    expect(recorded.filter((call) => call.op !== "select")).toEqual([]);
  });

  test("customer_seat.revoked no-ops without deleting anything", async () => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [NO_TEAM] }));

    await applyTeamPolarWebhookEvent("customer_seat.revoked", "team_gone", {
      id: "seat_1",
      seatMetadata: { userId: "user_2", teamId: "team_gone" },
    });

    expect(recorded.filter((call) => call.op === "delete")).toEqual([]);
  });

  test("customer_seat.assigned no-ops (the seat-id update matches no rows)", async () => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({}));

    await expect(
      applyTeamPolarWebhookEvent("customer_seat.assigned", "team_gone", {
        id: "seat_1",
        seatMetadata: { userId: "user_2", teamId: "team_gone" },
      })
    ).resolves.toBeUndefined();
  });
});

describe("subscription event guards", () => {
  const subscriptionEvent = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    customerId: "cus_1",
    status: "active",
    seats: 3,
    currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-08-31T00:00:00Z"),
    cancelAtPeriodEnd: false,
    ...overrides,
  });

  const teamsUpdates = () =>
    recorded.filter((call) => call.table === "teams" && call.op === "update");

  test("ignores events for a foreign subscription while another is live", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: "sub_live",
              subscription_status: "active",
              seats: 5,
              period_start: "2026-08-01T00:00:00.000Z",
            },
          },
        ],
      })
    );

    await applyTeamPolarWebhookEvent("subscription.updated", "team_1", subscriptionEvent("sub_2"));

    expect(teamsUpdates()).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
  });

  test("ignores updated/active for a deactivated team", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deactivatedRow = {
      data: {
        polar_subscription_id: null,
        subscription_status: null,
        seats: 5,
        period_start: null,
      },
    };
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "teams:select": [deactivatedRow, deactivatedRow] })
    );

    await applyTeamPolarWebhookEvent("subscription.updated", "team_1", subscriptionEvent("sub_1"));
    await applyTeamPolarWebhookEvent("subscription.active", "team_1", subscriptionEvent("sub_1"));

    expect(teamsUpdates()).toEqual([]);
    expect(consoleWarn).toHaveBeenCalledTimes(2);
  });

  test("subscription.created reactivates a deactivated team with a fresh pool", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: null,
              subscription_status: null,
              seats: 5,
              period_start: null,
            },
          },
        ],
        "teams:update": [{}],
      })
    );

    await applyTeamPolarWebhookEvent(
      "subscription.created",
      "team_1",
      subscriptionEvent("sub_new")
    );

    expect(teamsUpdates()).toHaveLength(1);
    expect(teamsUpdates()[0].payload).toMatchObject({
      polar_subscription_id: "sub_new",
      subscription_status: "active",
      requests_used: 0,
      // The checkout that produced this subscription stops being reusable.
      pending_checkout: null,
    });
  });

  test("the renewal reset is conditioned on the observed subscription id and period start", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: "sub_1",
              subscription_status: "active",
              seats: 3,
              period_start: "2026-07-01T00:00:00.000Z",
            },
          },
        ],
        "teams:update": [{}],
      })
    );

    await applyTeamPolarWebhookEvent("subscription.updated", "team_1", subscriptionEvent("sub_1"));

    // Two overlapping deliveries of the same renewal must not both zero the
    // pool: the write carries optimistic filters on the state that was read,
    // so the loser matches no rows.
    const update = recordedFilters.find((c) => c.table === "teams" && c.op === "update");
    expect(update).toBeDefined();
    expect(update!.filters).toContainEqual(["eq", "polar_subscription_id", "sub_1"]);
    expect(update!.filters).toContainEqual(["eq", "period_start", "2026-07-01T00:00:00.000Z"]);
    expect(teamsUpdates()[0].payload).toMatchObject({ requests_used: 0 });
  });

  test("a non-renewal update is compare-and-swapped on the observed state too", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: "sub_1",
              subscription_status: "active",
              seats: 3,
              period_start: "2026-08-01T00:00:00.000Z",
            },
          },
        ],
        "teams:update": [{}],
      })
    );

    await applyTeamPolarWebhookEvent("subscription.updated", "team_1", subscriptionEvent("sub_1"));

    // An updated/active event read before a concurrent revoke must not
    // resurrect the revoked subscription's state after it.
    const update = recordedFilters.find((c) => c.table === "teams" && c.op === "update");
    expect(update).toBeDefined();
    expect(update!.filters).toContainEqual(["eq", "polar_subscription_id", "sub_1"]);
    expect(update!.filters).toContainEqual(["eq", "period_start", "2026-08-01T00:00:00.000Z"]);
  });

  test("terminal transitions are conditioned on the live subscription id", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          { data: { polar_subscription_id: "sub_1" } },
          { data: { polar_subscription_id: "sub_1" } },
        ],
        "teams:update": [{}, {}],
      })
    );

    await applyTeamPolarWebhookEvent("subscription.canceled", "team_1", { id: "sub_1" });
    await applyTeamPolarWebhookEvent("subscription.revoked", "team_1", { id: "sub_1" });

    const updates = recordedFilters.filter((c) => c.table === "teams" && c.op === "update");
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      // A replacement subscription committing between the liveness read and
      // this write must turn the write into a no-op, not get clobbered.
      expect(update.filters).toContainEqual(["eq", "polar_subscription_id", "sub_1"]);
    }
  });
});

describe("extractTeamIdFromWebhook", () => {
  test("prefers the customer metadata team id", () => {
    expect(
      extractTeamIdFromWebhook({
        customer: { metadata: { teamId: "team_1" }, externalId: "team:other" },
      })
    ).toBe("team_1");
  });

  test("strips the team prefix from the customer external id", () => {
    expect(extractTeamIdFromWebhook({ customer: { externalId: "team:team_2" } })).toBe("team_2");
  });

  test("returns null for a personal customer", () => {
    expect(
      extractTeamIdFromWebhook({
        customer: { externalId: "user_1", metadata: { userId: "user_1" } },
      })
    ).toBeNull();
  });

  test("routes seat events by their seat metadata", () => {
    expect(extractTeamIdFromWebhook({ id: "seat_1", seatMetadata: { teamId: "team_3" } })).toBe(
      "team_3"
    );
  });
});

describe("TeamBillingError", () => {
  test("carries a machine-readable code", () => {
    const error = new TeamBillingError("not_owner", "Only the team owner can manage billing");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("not_owner");
    expect(error.message).toBe("Only the team owner can manage billing");
  });
});
