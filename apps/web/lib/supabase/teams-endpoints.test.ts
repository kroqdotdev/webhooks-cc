import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  requireActiveTeam: vi.fn(),
}));

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

vi.mock("./teams-gating", () => ({
  requireActiveTeam: mockFns.requireActiveTeam,
}));

import { listTeamEndpoints } from "./teams-endpoints";

// ---------------------------------------------------------------------------
// Minimal supabase-js query-builder double (same shape as
// teams-invites.test.ts). Responses are queued per `${table}:${operation}`
// and consumed in call order; filters are recorded for assertions.
// ---------------------------------------------------------------------------

interface QueryResult {
  data?: unknown;
  error?: unknown;
}

interface RecordedCall {
  table: string;
  op: string;
  filters: [string, string, unknown][];
}

let recorded: RecordedCall[] = [];

function createFakeAdmin(responses: Record<string, QueryResult[]>) {
  return {
    from(table: string) {
      let op = "select";
      const filters: [string, string, unknown][] = [];

      const take = (): QueryResult => {
        const queue = responses[`${table}:${op}`];
        return { data: null, error: null, ...queue?.shift() };
      };

      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["not", "order", "limit", "select", "neq"] as const) {
        builder[method] = chain;
      }
      for (const method of ["eq", "is", "in"] as const) {
        builder[method] = (column: string, value: unknown) => {
          filters.push([method, column, value]);
          return builder;
        };
      }
      for (const method of ["insert", "update", "delete"] as const) {
        builder[method] = () => {
          op = method;
          return builder;
        };
      }

      const settle = () => {
        recorded.push({ table, op, filters });
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

const TEAM = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  recorded = [];
  vi.clearAllMocks();
});

describe("listTeamEndpoints", () => {
  test("returns every share in share order with owner details", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [{ data: { id: "member_1" } }],
        "team_endpoints:select": [
          {
            data: [
              { endpoint_id: "ep_1", shared_by: "user_2", shared_at: "2026-10-01T10:00:00Z" },
              { endpoint_id: "ep_2", shared_by: "user_1", shared_at: "2026-10-02T10:00:00Z" },
            ],
          },
        ],
        "endpoints:select": [
          {
            data: [
              { id: "ep_2", user_id: "user_1", slug: "acme-two", name: null, request_count: 0 },
              { id: "ep_1", user_id: "user_2", slug: "acme-one", name: "Acme", request_count: 42 },
            ],
          },
        ],
        "users:select": [
          {
            data: [
              { id: "user_1", email: "owner@example.com", name: "Owner" },
              { id: "user_2", email: "member@example.com", name: null },
            ],
          },
        ],
      })
    );

    await expect(listTeamEndpoints("user_1", TEAM)).resolves.toEqual([
      {
        id: "ep_1",
        slug: "acme-one",
        name: "Acme",
        ownerId: "user_2",
        ownerName: null,
        ownerEmail: "member@example.com",
        sharedBy: "user_2",
        sharedAt: Date.parse("2026-10-01T10:00:00Z"),
        requestCount: 42,
      },
      {
        id: "ep_2",
        slug: "acme-two",
        name: null,
        ownerId: "user_1",
        ownerName: "Owner",
        ownerEmail: "owner@example.com",
        sharedBy: "user_1",
        sharedAt: Date.parse("2026-10-02T10:00:00Z"),
        requestCount: 0,
      },
    ]);

    const shares = recorded.find((c) => c.table === "team_endpoints");
    expect(shares?.filters).toEqual([["eq", "team_id", TEAM]]);
    // Metadata only: a suspended team still lists its shares.
    expect(mockFns.requireActiveTeam).not.toHaveBeenCalled();
  });

  test("returns null for a non-member and reads no endpoint details", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [{ data: null }],
        "team_endpoints:select": [
          { data: [{ endpoint_id: "ep_1", shared_by: "u", shared_at: "2026-10-01T00:00:00Z" }] },
        ],
      })
    );

    await expect(listTeamEndpoints("user_9", TEAM)).resolves.toBeNull();
    expect(recorded.some((c) => c.table === "endpoints" || c.table === "users")).toBe(false);
  });

  test("returns null for a malformed team id without a query", async () => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({}));

    await expect(listTeamEndpoints("user_1", "not-a-uuid")).resolves.toBeNull();
    expect(recorded).toEqual([]);
  });

  test("returns an empty list when nothing is shared", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [{ data: { id: "member_1" } }],
        "team_endpoints:select": [{ data: [] }],
      })
    );

    await expect(listTeamEndpoints("user_1", TEAM)).resolves.toEqual([]);
    expect(recorded.some((c) => c.table === "endpoints")).toBe(false);
  });

  test("skips a share whose endpoint row is gone", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [{ data: { id: "member_1" } }],
        "team_endpoints:select": [
          {
            data: [
              { endpoint_id: "ep_gone", shared_by: "user_1", shared_at: "2026-10-01T10:00:00Z" },
            ],
          },
        ],
        "endpoints:select": [{ data: [] }],
      })
    );

    await expect(listTeamEndpoints("user_1", TEAM)).resolves.toEqual([]);
    expect(recorded.some((c) => c.table === "users")).toBe(false);
  });

  test("a database error propagates", async () => {
    const dbError = { code: "57014", message: "canceling statement" };
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [{ data: { id: "member_1" } }],
        "team_endpoints:select": [{ error: dbError }],
      })
    );

    await expect(listTeamEndpoints("user_1", TEAM)).rejects.toBe(dbError);
  });
});
