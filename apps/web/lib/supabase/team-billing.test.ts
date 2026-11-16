import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockFns = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  createPolarClient: vi.fn(),
  recordRefund: vi.fn(),
  detachCheckoutLinks: vi.fn(),
  supersedeCheckoutLinks: vi.fn(),
  auditSystemEvent: vi.fn(),
}));

// The customer the event names, which a link named by its metadata must have.
const CUSTOMER_OF_EVENT = "cus_team_1";

vi.mock("@/lib/billing/refunds", () => ({ recordRefund: mockFns.recordRefund }));
vi.mock("@/lib/audit", () => ({ auditSystemEvent: mockFns.auditSystemEvent }));
vi.mock("@/lib/billing/checkout-link-rows", () => ({
  detachCheckoutLinks: mockFns.detachCheckoutLinks,
  supersedeCheckoutLinks: mockFns.supersedeCheckoutLinks,
}));

vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  return {
    createPolarClient: mockFns.createPolarClient,
    isEndedSubscriptionError: actual.isEndedSubscriptionError,
    loggablePolarError: (error: unknown) => error,
    polarErrorCode: actual.polarErrorCode,
    polarAppUrl: () => "https://webhooks.cc",
    teamPlanForProduct: actual.teamPlanForProduct,
    teamPlanProductId: actual.teamPlanProductId,
  };
});

vi.mock("./admin", () => ({
  createAdminClient: mockFns.createAdminClient,
}));

// Plan changes reconcile the add-ons afterwards; that module has its own tests.
vi.mock("./capacity-billing", () => ({
  reconcileAddonsWithPlan: vi.fn().mockResolvedValue(undefined),
}));

import { errors } from "@polar-sh/sdk/2026-10";
import {
  TeamBillingError,
  applyTeamPolarWebhookEvent,
  assignTeamSeat,
  cancelTeamSubscription,
  changeTeamPlan,
  createTeamCheckout,
  createTeamCustomerPortal,
  ensureOwnerSeat,
  extractTeamIdFromWebhook,
  teamCheckoutBlocked,
  teamPlanPurchase,
  keepTeamPlan,
  quoteTeamSeatChange,
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
  vi.stubEnv("POLAR_TEAMS_PRODUCT_ID", "prod_teams_123");
  vi.stubEnv("POLAR_TEAM_BUSINESS_MONTHLY_PRODUCT_ID", "prod_team_business_123");
  vi.stubEnv("POLAR_TEAM_BUSINESS_ANNUAL_PRODUCT_ID", "prod_team_business_year_123");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// Pending-seat syncs are versioned by our own clock; tests pin it.
const NOW = new Date("2026-10-06T08:00:00.000Z");
function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}

describe("createTeamCustomerPortal", () => {
  test("opens the portal as the team customer's owner member, back to the team page", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_customer_id: "cus_team" })],
      })
    );
    const list = vi.fn().mockResolvedValue({ items: [{ id: "mem_owner", role: "owner" }] });
    const create = vi.fn().mockResolvedValue({ customer_portal_url: "https://polar.test/portal" });
    mockFns.createPolarClient.mockReturnValue({
      customers: { members: { list } },
      customerSessions: { create },
    });

    await expect(createTeamCustomerPortal("user_1", "team_1")).resolves.toBe(
      "https://polar.test/portal"
    );
    expect(list).toHaveBeenCalledWith("cus_team", { role: "owner", limit: 1 });
    expect(create).toHaveBeenCalledWith({
      customer_id: "cus_team",
      member_id: "mem_owner",
      return_url: "https://webhooks.cc/teams/team_1",
    });
  });

  test("is for the team owner only", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "team_members:select": [{ data: null }] })
    );

    await expect(createTeamCustomerPortal("user_2", "team_1")).rejects.toMatchObject({
      code: "not_owner",
    });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("refuses a team that never had a Polar customer", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow()],
      })
    );

    await expect(createTeamCustomerPortal("user_1", "team_1")).rejects.toMatchObject({
      code: "no_customer",
    });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("refuses a team customer without an owner member instead of a session for no one", async () => {
    // A code of its own: the route reports it, unlike a team with no invoices.
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_customer_id: "cus_team" })],
      })
    );
    const create = vi.fn();
    mockFns.createPolarClient.mockReturnValue({
      customers: { members: { list: vi.fn().mockResolvedValue({ items: [] }) } },
      customerSessions: { create },
    });

    await expect(createTeamCustomerPortal("user_1", "team_1")).rejects.toMatchObject({
      code: "no_billing_contact",
    });
    expect(create).not.toHaveBeenCalled();
  });
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
    const checkoutCreate = vi.fn().mockResolvedValue({
      id: "chk_1",
      url: "https://sandbox.polar.sh/checkout/team",
      // Polar sends microseconds; the cache keeps milliseconds.
      expires_at: "2026-10-05T13:30:00.123456Z",
    });
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
      external_id: "team:team_1",
      metadata: { teamId: "team_1" },
      owner: { email: "owner@example.com", name: "Owner", external_id: "user_1" },
    });
    expect(checkoutCreate).toHaveBeenCalledWith({
      products: ["prod_teams_123", "prod_team_business_123", "prod_team_business_year_123"],
      seats: 5,
      success_url: "https://webhooks.cc/teams/team_1?subscribed=true",
      customer_id: "cus_team_1",
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
      id: "chk_1",
      url: "https://sandbox.polar.sh/checkout/team",
      seats: 5,
      expires_at: "2026-10-05T13:30:00.123Z",
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
              product: "prod_teams_123",
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

  test("moves the open session to another seat count or plan instead of opening a second", async () => {
    const createdAt = new Date(Date.now() - 60_000).toISOString();
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
              product: "prod_teams_123",
              created_at: createdAt,
            },
          }),
        ],
        "teams:update": [{}],
      })
    );

    const checkoutCreate = vi.fn();
    const checkoutUpdate = vi.fn().mockResolvedValue({ id: "co_1" });
    mockFns.createPolarClient.mockReturnValue({
      checkouts: { create: checkoutCreate, update: checkoutUpdate },
    });

    await expect(createTeamCheckout("user_1", "team_1", 5, "team_business", "year")).resolves.toBe(
      "https://sandbox.polar.sh/checkout/cached"
    );
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(checkoutUpdate).toHaveBeenCalledWith("co_1", {
      product_id: "prod_team_business_year_123",
      seats: 5,
      // Moved by the dashboard, it names no checkout link.
      metadata: {},
    });
    // Links that followed it no longer do.
    expect(mockFns.detachCheckoutLinks).toHaveBeenCalledWith("co_1", undefined);
    // The cache follows, fenced on the session it read.
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: {
        pending_checkout: {
          id: "co_1",
          url: "https://sandbox.polar.sh/checkout/cached",
          seats: 5,
          product: "prod_team_business_year_123",
          created_at: createdAt,
          expires_at: null,
        },
      },
    });
    const cacheWrite = recordedFilters.find((c) => c.table === "teams" && c.op === "update");
    expect(cacheWrite?.filters).toContainEqual(["eq", "pending_checkout->>created_at", createdAt]);
  });

  describe("for a checkout link", () => {
    const LINK = { id: "link_1", successUrl: "https://mailhooks.cc/checkout/complete" };
    const createdAt = () => new Date(Date.now() - 60_000).toISOString();
    const openTeam = (at: string, extra: Record<string, unknown> = {}) =>
      teamRow({
        polar_customer_id: "cus_team_1",
        pending_checkout: {
          id: "co_1",
          url: "https://sandbox.polar.sh/checkout/cached",
          seats: 3,
          product: "prod_teams_123",
          created_at: at,
          expires_at: "2099-01-01T00:00:00.000Z",
          ...extra,
        },
      });

    test("is checked without Polar, and refuses a member", async () => {
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "team_members:select": [OWNER_MEMBERSHIP],
          "teams:select": [openTeam(createdAt())],
        })
      );
      const purchase = await teamPlanPurchase("user_1", "team_1", 3, "team", "month");
      expect(purchase.expected).toEqual({ product: "prod_teams_123", seats: 3 });
      expect(mockFns.createPolarClient).not.toHaveBeenCalled();

      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({ "team_members:select": [{ data: null }] })
      );
      await expect(teamPlanPurchase("user_2", "team_1", 3)).rejects.toMatchObject({
        code: "not_owner",
      });
    });

    test("reuses the open session when it buys the same plan and seats, naming the link", async () => {
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "team_members:select": [OWNER_MEMBERSHIP],
          "teams:select": [openTeam(createdAt())],
        })
      );
      const checkoutUpdate = vi.fn().mockResolvedValue({});
      const checkoutCreate = vi.fn();
      mockFns.createPolarClient.mockReturnValue({
        checkouts: { create: checkoutCreate, update: checkoutUpdate },
      });
      const purchase = await teamPlanPurchase("user_1", "team_1", 3, "team", "month");
      await expect(purchase.mint(LINK)).resolves.toEqual({
        id: "co_1",
        url: "https://sandbox.polar.sh/checkout/cached",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(checkoutCreate).not.toHaveBeenCalled();
      expect(checkoutUpdate).toHaveBeenCalledWith("co_1", {
        metadata: { checkout_link: "link_1" },
      });
    });

    test("with none open, mints a session for its plan and exactly its seats, cached as fixed", async () => {
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "team_members:select": [OWNER_MEMBERSHIP],
          "teams:select": [teamRow({ polar_customer_id: "cus_team_1" })],
          // The lease claim, then the session cached.
          "teams:update": [{ data: { id: "team_1" } }, {}],
        })
      );
      const checkoutCreate = vi.fn().mockResolvedValue({
        id: "co_2",
        url: "https://sandbox.polar.sh/checkout/link",
        expires_at: "2026-10-05T13:30:00Z",
      });
      mockFns.createPolarClient.mockReturnValue({ checkouts: { create: checkoutCreate } });

      const purchase = await teamPlanPurchase("user_1", "team_1", 4, "team_business", "year");
      await expect(purchase.mint(LINK)).resolves.toEqual({
        id: "co_2",
        url: "https://sandbox.polar.sh/checkout/link",
        expiresAt: "2026-10-05T13:30:00.000Z",
      });
      expect(checkoutCreate).toHaveBeenCalledWith({
        products: ["prod_team_business_year_123"],
        seats: 4,
        min_seats: 4,
        max_seats: 4,
        success_url: "https://mailhooks.cc/checkout/complete",
        customer_id: "cus_team_1",
        metadata: { checkout_link: "link_1" },
      });
      const cached = recorded.filter((c) => c.table === "teams" && c.op === "update")[1]
        ?.payload as { pending_checkout: Record<string, unknown> };
      expect(cached.pending_checkout).toMatchObject({ id: "co_2", seats: 4, fixed: true });
    });

    test("moves the dashboard's open session to its plan and seats, letting other links go", async () => {
      const at = createdAt();
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "team_members:select": [OWNER_MEMBERSHIP],
          "teams:select": [openTeam(at)],
        })
      );
      const checkoutUpdate = vi.fn().mockResolvedValue({});
      const checkoutCreate = vi.fn();
      mockFns.createPolarClient.mockReturnValue({
        checkouts: { create: checkoutCreate, update: checkoutUpdate },
      });

      const purchase = await teamPlanPurchase("user_1", "team_1", 5, "team", "month");
      await expect(purchase.mint(LINK)).resolves.toMatchObject({ id: "co_1" });
      expect(checkoutCreate).not.toHaveBeenCalled();
      expect(checkoutUpdate).toHaveBeenCalledWith("co_1", {
        product_id: "prod_teams_123",
        seats: 5,
        metadata: { checkout_link: "link_1" },
      });
      expect(mockFns.detachCheckoutLinks).toHaveBeenCalledWith("co_1", "link_1");
    });

    test("never opens a second payable session beside a link's fixed one", async () => {
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "team_members:select": [OWNER_MEMBERSHIP],
          "teams:select": [openTeam(createdAt(), { fixed: true })],
        })
      );
      const checkoutCreate = vi.fn();
      const checkoutUpdate = vi.fn();
      mockFns.createPolarClient.mockReturnValue({
        checkouts: { create: checkoutCreate, update: checkoutUpdate },
      });

      await expect(createTeamCheckout("user_1", "team_1", 5)).rejects.toMatchObject({
        code: "checkout_in_progress",
        // When the person can try again.
        message: expect.stringContaining("until 00:00 UTC (2099-01-01T00:00:00.000Z)"),
      });
      // The link's session keeps buying what the link says, and no other is made.
      expect(checkoutCreate).not.toHaveBeenCalled();
      expect(checkoutUpdate).not.toHaveBeenCalled();
      expect(mockFns.detachCheckoutLinks).not.toHaveBeenCalled();
      expect(recorded.some((call) => call.table === "teams" && call.op === "update")).toBe(false);
    });

    test("says, from the database alone, when another link's fixed session blocks this one", async () => {
      const fixed = openTeam(createdAt(), { fixed: true });
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [fixed] }));
      // Another seat count: blocked until the fixed session expires.
      await expect(
        teamCheckoutBlocked("team_1", { product: "prod_teams_123", seats: 5 })
      ).resolves.toEqual({
        code: "checkout_in_progress",
        message: expect.stringContaining("until 00:00 UTC (2099-01-01T00:00:00.000Z)"),
      });
      // The same plan and seats: that session is this purchase's to reuse.
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [fixed] }));
      await expect(
        teamCheckoutBlocked("team_1", { product: "prod_teams_123", seats: 3 })
      ).resolves.toBeNull();
      // A dashboard session can be moved, so it blocks nothing.
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({ "teams:select": [openTeam(createdAt())] })
      );
      await expect(
        teamCheckoutBlocked("team_1", { product: "prod_teams_123", seats: 5 })
      ).resolves.toBeNull();
    });

    test("lets go of the moved session's links before caching what it sells now", async () => {
      const at = createdAt();
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "team_members:select": [OWNER_MEMBERSHIP],
          "teams:select": [openTeam(at)],
        })
      );
      const checkoutUpdate = vi.fn().mockResolvedValue({});
      mockFns.createPolarClient.mockReturnValue({
        checkouts: { create: vi.fn(), update: checkoutUpdate },
      });
      mockFns.detachCheckoutLinks.mockRejectedValueOnce(new Error("connection reset"));

      const purchase = await teamPlanPurchase("user_1", "team_1", 5, "team", "month");
      await expect(purchase.mint(LINK)).rejects.toThrow("connection reset");
      // The cache still holds the old purchase, so a retry moves and detaches again.
      expect(recorded.some((call) => call.table === "teams" && call.op === "update")).toBe(false);
    });
  });

  test("does not open a second session when the open one cannot change", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
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
              product: "prod_teams_123",
              created_at: new Date(Date.now() - 60_000).toISOString(),
            },
          }),
        ],
      })
    );
    const checkoutCreate = vi.fn();
    const checkoutUpdate = vi.fn().mockRejectedValue(new Error("Product is not available"));
    mockFns.createPolarClient.mockReturnValue({
      checkouts: { create: checkoutCreate, update: checkoutUpdate },
    });

    await expect(createTeamCheckout("user_1", "team_1", 5)).rejects.toMatchObject({
      code: "checkout_in_progress",
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
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
              product: "prod_teams_123",
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
              product: "prod_teams_123",
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
              product: "prod_teams_123",
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
                product: "prod_teams_123",
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
  test("refuses to schedule a reduction below the current member count", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({ polar_subscription_id: "sub_1", seats: 5, pending_seats: null }),
        ],
        "rpc:schedule_team_seat_reduction": [
          { data: { status: "below_members", member_count: 4 } },
        ],
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

  test("reduction: schedules it under the row lock, then asks Polar for next_period", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({ polar_subscription_id: "sub_1", seats: 6, pending_seats: null }),
        ],
        "rpc:schedule_team_seat_reduction": [
          { data: { status: "ok", previous_pending_seats: null } },
        ],
      })
    );

    const rpcWrite = {
      table: "rpc:schedule_team_seat_reduction",
      op: "rpc",
      payload: { p_team_id: "team_1", p_seats: 3 },
    };
    const subscriptionUpdate = vi.fn().mockImplementation(() => {
      // The RPC's row lock is what serializes the reduction against concurrent
      // invite accepts, so it must land before Polar is told.
      expect(recorded).toContainEqual(rpcWrite);
      return Promise.resolve({ id: "sub_1" });
    });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await updateTeamSeats("user_1", "team_1", 3);

    expect(subscriptionUpdate).toHaveBeenCalledWith("sub_1", {
      seats: 3,
      proration_behavior: "next_period",
    });
    // Seats, member cap and pool stay as paid until the renewal.
    expect(recorded.filter((call) => call.table === "rpc:update_team_seats")).toEqual([]);
  });

  test("keeping the current seats cancels a scheduled reduction", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 5, pending_seats: 3 })],
        "rpc:schedule_team_seat_reduction": [{ data: { status: "ok", previous_pending_seats: 3 } }],
      })
    );
    const subscriptionUpdate = vi.fn().mockResolvedValue({ id: "sub_1" });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await updateTeamSeats("user_1", "team_1", 5);

    expect(recorded).toContainEqual({
      table: "rpc:schedule_team_seat_reduction",
      op: "rpc",
      payload: { p_team_id: "team_1", p_seats: 5 },
    });
    expect(subscriptionUpdate).toHaveBeenCalledWith("sub_1", {
      seats: 5,
      proration_behavior: "next_period",
    });
  });

  test("the current seat count with nothing scheduled is a no-op", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({ polar_subscription_id: "sub_1", seats: 5, pending_seats: null }),
        ],
      })
    );

    await updateTeamSeats("user_1", "team_1", 5);

    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
    expect(recorded.filter((call) => call.op === "rpc")).toEqual([]);
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
    freezeClock();

    await updateTeamSeats("user_1", "team_1", 6);

    expect(subscriptionUpdate).toHaveBeenCalledWith("sub_1", {
      seats: 6,
      proration_behavior: "invoice",
    });
    expect(recorded).toContainEqual(rpcWrite);
    // Polar dropped any pending reduction; recorded with the confirmation time
    // so an older read cannot bring it back.
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: {
        pending_seats: null,
        pending_plan: null,
        pending_interval: null,
        pending_seats_as_of: NOW.toISOString(),
      },
    });
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

  test("increase: a declined charge becomes payment_failed and adds no seats", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 2 })],
      })
    );

    const declined = new errors.SubscriptionsUpdate402Error(402, {
      error: "PaymentFailed",
      detail: "Payment failed with reason: card_error.",
    });
    const subscriptionUpdate = vi.fn().mockRejectedValue(declined);
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await expect(updateTeamSeats("user_1", "team_1", 3)).rejects.toMatchObject({
      name: "TeamBillingError",
      code: "payment_failed",
    });
    expect(recorded.filter((call) => call.table === "rpc:update_team_seats")).toEqual([]);
  });

  test("increase: an approved one refuses before Polar when the period or seats moved", async () => {
    const row = () => teamRow({ polar_subscription_id: "sub_1", seats: 2 });
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP, OWNER_MEMBERSHIP],
        "teams:select": [row(), row()],
      })
    );
    const subscriptionUpdate = vi.fn();
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    // The renewal crossed since the quote: Polar would charge a new period.
    const past = new Date(Date.now() - 1000).toISOString();
    await expect(
      updateTeamSeats("user_1", "team_1", 3, {
        currentSeats: 2,
        periodEnd: past,
        direction: "increase",
      })
    ).rejects.toMatchObject({ code: "quote_changed" });
    // Seats changed since the quote.
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await expect(
      updateTeamSeats("user_1", "team_1", 3, {
        currentSeats: 4,
        periodEnd: later,
        direction: "increase",
      })
    ).rejects.toMatchObject({ code: "quote_changed" });
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  test("an approved change refuses when this database would take it the other way", async () => {
    // Polar bills 5 seats and the quote priced 4 as a reduction at the
    // renewal, but this database shows 3: here 4 would be an increase,
    // charged now.
    const row = () => teamRow({ polar_subscription_id: "sub_1", seats: 3 });
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP, OWNER_MEMBERSHIP],
        "teams:select": [row(), row()],
      })
    );
    const subscriptionUpdate = vi.fn();
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await expect(
      updateTeamSeats("user_1", "team_1", 4, {
        currentSeats: 3,
        periodEnd: later,
        direction: "reduction",
      })
    ).rejects.toMatchObject({ code: "quote_changed" });
    // And an increase quoted on Polar's 1 seat that this database would
    // schedule as a reduction from its 3.
    await expect(
      updateTeamSeats("user_1", "team_1", 2, {
        currentSeats: 3,
        periodEnd: later,
        direction: "increase",
      })
    ).rejects.toMatchObject({ code: "quote_changed" });
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(recorded.filter((call) => call.op === "rpc")).toEqual([]);
  });

  test("an approved change to the count Polar bills already goes the database's way", async () => {
    // Polar bills 5, this database shows 3 after a failed write: keeping 5
    // sets ours to 5 at once, and Polar (already at 5) charges nothing.
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 3 })],
        "rpc:update_team_seats": [{ data: { status: "ok" } }],
      })
    );
    const subscriptionUpdate = vi.fn().mockResolvedValue({ id: "sub_1", pending_update: null });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await updateTeamSeats("user_1", "team_1", 5, {
      currentSeats: 3,
      periodEnd: later,
      direction: "same",
    });
    expect(subscriptionUpdate).toHaveBeenCalledWith("sub_1", {
      seats: 5,
      proration_behavior: "invoice",
    });
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

  test("reduction: restores the previous schedule only while it still holds this request", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 6, pending_seats: 4 })],
        "rpc:schedule_team_seat_reduction": [{ data: { status: "ok", previous_pending_seats: 4 } }],
        "teams:update": [{}],
      })
    );

    const subscriptionUpdate = vi.fn().mockRejectedValue(new Error("polar down"));
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await expect(updateTeamSeats("user_1", "team_1", 3)).rejects.toThrow("polar down");

    const restore = recordedFilters.find((c) => c.table === "teams" && c.op === "update");
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: { pending_seats: 4 },
    });
    // An overlapping request that scheduled something else since must win.
    expect(restore!.filters).toContainEqual(["eq", "pending_seats", 3]);
  });

  test("reduction: records Polar's resulting schedule with its version", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({ polar_subscription_id: "sub_1", seats: 6, pending_seats: null }),
        ],
        "rpc:schedule_team_seat_reduction": [
          { data: { status: "ok", previous_pending_seats: null } },
        ],
        "teams:update": [{}],
      })
    );
    freezeClock();
    const subscriptionUpdate = vi.fn().mockResolvedValue({
      id: "sub_1",
      seats: 6,
      // Polar leaves this alone when it schedules a change, so it is not the version.
      modified_at: "2026-10-01T14:00:00.123456Z",
      pending_update: { seats: 3, applies_at: "2026-11-01T00:00:00.000000Z" },
    });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update: subscriptionUpdate } });

    await updateTeamSeats("user_1", "team_1", 3);

    // Stamped with the time Polar's confirmation arrived.
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: {
        pending_seats: 3,
        pending_plan: null,
        pending_interval: null,
        pending_seats_as_of: NOW.toISOString(),
      },
    });
    const sync = recordedFilters.find((c) => c.table === "teams" && c.op === "update");
    expect(sync!.filters).toContainEqual(["eq", "polar_subscription_id", "sub_1"]);
    expect(sync!.filters).toContainEqual([
      "or",
      `pending_seats_as_of.is.null,pending_seats_as_of.lt."${NOW.toISOString()}"`,
      null,
    ]);
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
      subscription_id: "sub_1",
      email: "member@example.com",
      immediate_claim: true,
      metadata: { userId: "user_2", teamId: "team_1" },
    });
  });
});

describe("quoteTeamSeatChange", () => {
  async function* iterate<T>(items: T[]) {
    yield* items;
  }

  test("prices the change from Polar's live subscription and spends unused credit", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [teamRow({ polar_subscription_id: "sub_1", seats: 4 })],
      })
    );
    const get = vi.fn().mockResolvedValue({
      customer_id: "cus_team",
      seats: 4,
      amount: 4800,
      current_period_start: new Date(Date.now() - 15 * 86_400_000).toISOString(),
      current_period_end: new Date(Date.now() + 15 * 86_400_000).toISOString(),
    });
    const iterList = vi.fn(() =>
      iterate([
        { total_amount: 4800, applied_balance_amount: 0 },
        { total_amount: -300, applied_balance_amount: 0 },
      ])
    );
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { get }, orders: { iterList } });

    const quote = await quoteTeamSeatChange("user_1", "team_1", 5);

    expect(get).toHaveBeenCalledWith("sub_1");
    expect(iterList).toHaveBeenCalledWith({ customer_id: "cus_team", limit: 100 });
    expect(quote.pricePerSeatCents).toBe(1200);
    // Half the period left: one seat is $6.00 (give or take the test's runtime),
    // $3.00 of it paid from credit.
    expect(quote.prorationCents).toBeGreaterThanOrEqual(599);
    expect(quote.prorationCents).toBeLessThanOrEqual(600);
    expect(quote.creditAppliedCents).toBe(300);
    expect(quote.dueNowCents).toBe(quote.prorationCents - 300);
    expect(quote.renewalCents).toBe(6000);
  });

  test("refuses non-owners and teams without a subscription", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [{ data: null }, OWNER_MEMBERSHIP],
        "teams:select": [teamRow()],
      })
    );

    await expect(quoteTeamSeatChange("user_2", "team_1", 5)).rejects.toMatchObject({
      code: "not_owner",
    });
    await expect(quoteTeamSeatChange("user_1", "team_1", 5)).rejects.toMatchObject({
      code: "no_subscription",
    });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });
});

describe("ensureOwnerSeat", () => {
  const ownerRow = { data: { user_id: "user_owner", polar_seat_id: null } };
  const activeTeam = { data: { polar_subscription_id: "sub_1", subscription_status: "active" } };
  const ownerUser = { data: { email: "Owner@Example.com" } };

  const memberUpdates = () =>
    recorded.filter((call) => call.table === "team_members" && call.op === "update");

  test("assigns a claimed seat to an owner without one and records it", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [ownerRow],
        "teams:select": [activeTeam, { data: { polar_subscription_id: "sub_1" } }],
        "users:select": [ownerUser],
        "team_members:update": [{}],
      })
    );
    const listSeats = vi.fn().mockResolvedValue({ seats: [] });
    const assignSeat = vi.fn().mockResolvedValue({ id: "seat_owner" });
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { listSeats, assignSeat } });

    await ensureOwnerSeat("team_1");

    expect(assignSeat).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_id: "sub_1",
        email: "Owner@Example.com",
        immediate_claim: true,
        metadata: { userId: "user_owner", teamId: "team_1" },
      })
    );
    expect(memberUpdates()).toEqual([
      { table: "team_members", op: "update", payload: { polar_seat_id: "seat_owner" } },
    ]);
  });

  test("records a seat Polar already gave the owner instead of assigning another", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [ownerRow],
        "teams:select": [activeTeam],
        "users:select": [ownerUser],
        "team_members:update": [{}],
      })
    );
    const listSeats = vi.fn().mockResolvedValue({
      seats: [{ id: "seat_auto", status: "claimed", customer_email: "owner@example.com" }],
    });
    const assignSeat = vi.fn();
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { listSeats, assignSeat } });

    await ensureOwnerSeat("team_1");

    expect(assignSeat).not.toHaveBeenCalled();
    expect(memberUpdates()[0].payload).toEqual({ polar_seat_id: "seat_auto" });
  });

  test("does nothing for an inactive team", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [ownerRow],
        "teams:select": [{ data: { polar_subscription_id: null, subscription_status: null } }],
      })
    );

    await ensureOwnerSeat("team_1");

    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
    expect(memberUpdates()).toEqual([]);
  });

  test("keeps a stored seat that is still the owner's live seat", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [{ data: { user_id: "user_owner", polar_seat_id: "seat_1" } }],
        "teams:select": [activeTeam],
        "users:select": [ownerUser],
      })
    );
    const listSeats = vi.fn().mockResolvedValue({
      seats: [{ id: "seat_1", status: "claimed", email: "owner@example.com" }],
    });
    const assignSeat = vi.fn();
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { listSeats, assignSeat } });

    await ensureOwnerSeat("team_1");

    expect(assignSeat).not.toHaveBeenCalled();
    expect(memberUpdates()).toEqual([]);
  });

  test("replaces a stale seat id left by an earlier subscription", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [{ data: { user_id: "user_owner", polar_seat_id: "seat_old" } }],
        "teams:select": [activeTeam, { data: { polar_subscription_id: "sub_1" } }],
        "users:select": [ownerUser],
        "team_members:update": [{}, {}],
      })
    );
    // seat_old is not in the current subscription (or was recycled to someone
    // else), so it must be cleared and a fresh seat assigned.
    const listSeats = vi.fn().mockResolvedValue({
      seats: [{ id: "seat_old", status: "claimed", email: "someone-else@example.com" }],
    });
    const assignSeat = vi.fn().mockResolvedValue({ id: "seat_new" });
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { listSeats, assignSeat } });

    await ensureOwnerSeat("team_1");

    expect(assignSeat).toHaveBeenCalled();
    expect(memberUpdates().map((call) => call.payload)).toEqual([
      { polar_seat_id: null },
      { polar_seat_id: "seat_new" },
    ]);
    const clear = recordedFilters.find((c) => c.table === "team_members" && c.op === "update");
    expect(clear!.filters).toContainEqual(["eq", "polar_seat_id", "seat_old"]);
  });

  test("treats SeatAlreadyAssigned from a concurrent delivery as success", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [ownerRow],
        "teams:select": [activeTeam, { data: { polar_subscription_id: "sub_1" } }],
        "users:select": [ownerUser],
        "team_members:update": [{}],
      })
    );
    const listSeats = vi
      .fn()
      .mockResolvedValueOnce({ seats: [] })
      .mockResolvedValueOnce({
        seats: [{ id: "seat_raced", status: "claimed", email: "owner@example.com" }],
      });
    const assignSeat = vi.fn().mockRejectedValue(
      new errors.CustomerSeatsAssignSeat400Error(400, {
        error: "SeatAlreadyAssigned",
        detail: "Seat already assigned",
      } as never)
    );
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { listSeats, assignSeat } });

    await ensureOwnerSeat("team_1");

    expect(memberUpdates()[0].payload).toEqual({ polar_seat_id: "seat_raced" });
  });

  test("logs instead of throwing when Polar fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [ownerRow],
        "teams:select": [activeTeam],
        "users:select": [ownerUser],
      })
    );
    const listSeats = vi.fn().mockRejectedValue(new Error("polar down"));
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { listSeats } });

    await expect(ensureOwnerSeat("team_1")).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
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
        { id: "seat_old", status: "revoked", customer_email: "member@example.com", email: null },
        { id: "seat_1", status: "claimed", customer_email: "Member@Example.com", email: null },
      ],
    });
    const revokeSeat = vi.fn().mockResolvedValue({ id: "seat_1" });
    mockFns.createPolarClient.mockReturnValue({ customerSeats: { listSeats, revokeSeat } });

    await revokeTeamSeat("team_1", null, "member@example.com");

    expect(listSeats).toHaveBeenCalledWith({ subscription_id: "sub_1" });
    expect(revokeSeat).toHaveBeenCalledWith("seat_1");
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
    expect(revokeSeat).toHaveBeenCalledWith("seat_1");
    expect(consoleError).toHaveBeenCalled();
  });
});

describe("complimentary (staff) teams", () => {
  const COMPLIMENTARY = "This team is complimentary (staff) and has no subscription to change";
  const staffTeam = () =>
    teamRow({
      polar_subscription_id: null,
      subscription_status: "active",
      business: true,
      seats: 10,
      billing_interval: "month",
    });

  function ownerAdmin() {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [staffTeam()],
      })
    );
  }

  test.each([
    ["cancelling", () => cancelTeamSubscription("user_1", "team_1")],
    ["resuming", () => resubscribeTeam("user_1", "team_1")],
    ["changing seats", () => updateTeamSeats("user_1", "team_1", 12)],
    ["quoting seats", () => quoteTeamSeatChange("user_1", "team_1", 12)],
    ["changing the plan", () => changeTeamPlan("user_1", "team_1", "team", "month")],
    ["keeping the plan", () => keepTeamPlan("user_1", "team_1")],
  ])("%s is refused before Polar is asked", async (_what, call) => {
    ownerAdmin();
    await expect(call()).rejects.toMatchObject({ code: "no_subscription", message: COMPLIMENTARY });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("a checkout is refused as already live", async () => {
    ownerAdmin();
    await expect(createTeamCheckout("user_1", "team_1", 5, "team_business")).rejects.toMatchObject({
      code: "already_subscribed",
      message: "This team is complimentary (staff) and needs no subscription",
    });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("the billing portal says there are no invoices", async () => {
    ownerAdmin();
    await expect(createTeamCustomerPortal("user_1", "team_1")).rejects.toMatchObject({
      code: "no_customer",
      message: "This team is complimentary (staff) and has no invoices",
    });
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
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

    expect(subscriptionUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
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

    expect(subscriptionUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: false });
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

    expect(revoke).toHaveBeenCalledWith("sub_1");
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
    // The team's own subscription, which the deletion revoked: Polar's
    // current state says so, whatever the late event carried.
    const revoke = vi.fn();
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: {
        get: vi.fn().mockResolvedValue({ id: "sub_1", status: "canceled", ended_at: "2026-08-02" }),
        revoke,
      },
    });

    await applyTeamPolarWebhookEvent(eventType, "team_gone", {
      id: "sub_1",
      customer_id: "cus_1",
      status: "active",
      seats: 2,
    });

    expect(recorded.filter((call) => call.op !== "select")).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    expect(mockFns.recordRefund).not.toHaveBeenCalled();
  });

  test("ends a live subscription whose team is gone and records its refund", async () => {
    // A checkout that completed after the team was deleted.
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [NO_TEAM] }));
    const revoke = vi.fn().mockResolvedValue({});
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: {
        get: vi.fn().mockResolvedValue({ id: "sub_late", status: "active", ended_at: null }),
        revoke,
      },
    });

    await applyTeamPolarWebhookEvent("subscription.created", "team_gone", {
      id: "sub_late",
      customer_id: "cus_1",
      status: "active",
      seats: 2,
    });

    expect(recorded.filter((call) => call.op !== "select")).toEqual([]);
    expect(revoke).toHaveBeenCalledWith("sub_late");
    expect(mockFns.recordRefund).toHaveBeenCalledWith({
      target: { subscription: "sub_late" },
      reason: "deleted_account",
      teamId: "team_gone",
    });
    expect(mockFns.recordRefund.mock.invocationCallOrder[0]).toBeLessThan(
      revoke.mock.invocationCallOrder[0]
    );
  });

  test("customer_seat.revoked no-ops without deleting anything", async () => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [NO_TEAM] }));

    await applyTeamPolarWebhookEvent("customer_seat.revoked", "team_gone", {
      id: "seat_1",
      seat_metadata: { userId: "user_2", teamId: "team_gone" },
    });

    expect(recorded.filter((call) => call.op === "delete")).toEqual([]);
  });

  test("customer_seat.assigned no-ops (the seat-id update matches no rows)", async () => {
    mockFns.createAdminClient.mockReturnValue(createFakeAdmin({}));

    await expect(
      applyTeamPolarWebhookEvent("customer_seat.assigned", "team_gone", {
        id: "seat_1",
        seat_metadata: { userId: "user_2", teamId: "team_gone" },
      })
    ).resolves.toBeUndefined();
  });
});

describe("subscription event guards", () => {
  const subscriptionEvent = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    customer_id: "cus_1",
    status: "active",
    seats: 3,
    current_period_start: new Date("2026-08-01T00:00:00Z").toISOString(),
    current_period_end: new Date("2026-08-31T00:00:00Z").toISOString(),
    cancel_at_period_end: false,
    ...overrides,
  });

  const teamsUpdates = () =>
    recorded.filter((call) => call.table === "teams" && call.op === "update");

  // Subscription events re-read the subscription from Polar to mirror its
  // pending seat change; by default Polar reports nothing scheduled.
  beforeEach(() => {
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: { get: vi.fn().mockResolvedValue({ pending_update: null }) },
    });
  });

  describe("a second live subscription", () => {
    const liveTeam = {
      data: {
        polar_subscription_id: "sub_live",
        subscription_status: "active",
        seats: 5,
        period_start: "2026-08-01T00:00:00.000Z",
      },
    };
    // A live Teams subscription on the team's customer, started an hour after
    // the stored one (sub_live, 2026-08-09T23:00Z in most cases): a twin.
    const TEAM_SUB = {
      status: "active",
      ended_at: null,
      product_id: "prod_teams_123",
      customer_id: "cus_team_1",
      started_at: "2026-08-10T00:00:00Z",
    };
    const polarState = (states: Record<string, Record<string, unknown>>) => {
      const revoke = vi.fn().mockResolvedValue({});
      mockFns.createPolarClient.mockReturnValue({
        subscriptions: {
          get: vi.fn(async (id: string) => states[id] ?? { id, status: "canceled" }),
          revoke,
        },
      });
      return revoke;
    };

    test("is refunded and revoked, and the team keeps the one it has", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-09T23:00:00Z" },
        sub_2: { ...TEAM_SUB, id: "sub_2", checkout_id: "co_2" },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_2")
      );

      expect(mockFns.recordRefund).toHaveBeenCalledWith({
        target: { subscription: "sub_2" },
        reason: "duplicate_plan",
        teamId: "team_1",
      });
      expect(revoke).toHaveBeenCalledWith("sub_2");
      expect(revoke).not.toHaveBeenCalledWith("sub_live");
      // A checkout link its session made reads superseded, never paid.
      expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalledWith(
        "co_2",
        undefined,
        CUSTOMER_OF_EVENT
      );
      // Recorded and superseded before the revoke: a redelivery after it
      // reads an ended one and never comes back here.
      expect(mockFns.recordRefund.mock.invocationCallOrder[0]).toBeLessThan(
        revoke.mock.invocationCallOrder[0]
      );
      expect(mockFns.supersedeCheckoutLinks.mock.invocationCallOrder[0]).toBeLessThan(
        revoke.mock.invocationCallOrder[0]
      );
      expect(recorded.filter((call) => call.op !== "select")).toEqual([]);
    });

    test("is not recorded again when the event is delivered after the revoke", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      // The event still carries the live copy; Polar's current state is ended.
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-09T23:00:00Z" },
        sub_2: { id: "sub_2", status: "canceled", ended_at: "2026-08-02T00:00:00Z" },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_2")
      );

      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(teamsUpdates()).toEqual([]);
      // An ended subscription's event needs nobody: a log line, no report.
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        "[team-billing] ignored an event for an ended subscription the team does not hold",
        expect.objectContaining({ eventSubscriptionId: "sub_2" })
      );
    });

    test("an old, ended subscription's late event refunds nothing", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-09T23:00:00Z" },
        sub_old: { id: "sub_old", status: "active", ended_at: "2026-07-01T00:00:00Z" },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.updated",
        "team_1",
        subscriptionEvent("sub_old")
      );

      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(teamsUpdates()).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    });

    test("refunds nothing while the stored subscription is no longer live in Polar", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      const revoke = polarState({
        sub_live: { id: "sub_live", status: "canceled", ended_at: "2026-08-02T00:00:00Z" },
        sub_2: { ...TEAM_SUB, id: "sub_2", checkout_id: "co_2" },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_2")
      );

      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(teamsUpdates()).toEqual([]);
      expect(consoleError).toHaveBeenCalled();
    });

    test("activating at the same moment as the first: the loser is read again and refunded", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const unsubscribed = {
        data: {
          polar_subscription_id: null,
          subscription_status: null,
          seats: 0,
          period_start: null,
        },
      };
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          // Read before the other activation wrote, then after it.
          "teams:select": [unsubscribed, liveTeam],
          // The activation fenced on no subscription matches no row.
          "teams:update": [{ data: [] }],
        })
      );
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-09T23:00:00Z" },
        sub_2: { ...TEAM_SUB, id: "sub_2", checkout_id: "co_2" },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_2")
      );

      const activation = recordedFilters.find((c) => c.table === "teams" && c.op === "update");
      expect(activation?.filters).toContainEqual(["is", "polar_subscription_id", null]);
      expect(teamsUpdates()).toHaveLength(1);
      expect(mockFns.recordRefund).toHaveBeenCalledWith({
        target: { subscription: "sub_2" },
        reason: "duplicate_plan",
        teamId: "team_1",
      });
      expect(revoke).toHaveBeenCalledWith("sub_2");
    });

    test("activating at the same moment: a loser that started first is still ended", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const unsubscribed = {
        data: {
          polar_subscription_id: null,
          subscription_status: null,
          seats: 0,
          period_start: null,
        },
      };
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          // Read before the other activation wrote, then after it.
          "teams:select": [unsubscribed, liveTeam],
          "teams:update": [{ data: [] }],
        })
      );
      // Twin checkouts: this one started 25 minutes before the one that won
      // the activation write, inside the two-hour window.
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-10T10:30:00Z" },
        sub_2: {
          ...TEAM_SUB,
          id: "sub_2",
          started_at: "2026-08-10T10:05:00Z",
          checkout_id: "co_2",
        },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_2")
      );

      expect(teamsUpdates()).toHaveLength(1);
      expect(mockFns.recordRefund).toHaveBeenCalledWith({
        target: { subscription: "sub_2" },
        reason: "duplicate_plan",
        teamId: "team_1",
      });
      expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalledWith(
        "co_2",
        undefined,
        CUSTOMER_OF_EVENT
      );
      expect(revoke).toHaveBeenCalledWith("sub_2");
      expect(revoke).not.toHaveBeenCalledWith("sub_live");
    });

    test("a second lost write still fails, so Polar delivers the event again", async () => {
      const unsubscribed = {
        data: {
          polar_subscription_id: null,
          subscription_status: null,
          seats: 0,
          period_start: null,
        },
      };
      mockFns.createAdminClient.mockReturnValue(
        createFakeAdmin({
          "teams:select": [unsubscribed, unsubscribed],
          "teams:update": [{ data: [] }, { data: [] }],
        })
      );
      polarState({ sub_2: { ...TEAM_SUB, id: "sub_2", checkout_id: "co_2" } });

      await expect(
        applyTeamPolarWebhookEvent("subscription.created", "team_1", subscriptionEvent("sub_2"))
      ).rejects.toMatchObject({ code: "concurrent_update" });
      expect(teamsUpdates()).toHaveLength(2);
      expect(mockFns.recordRefund).not.toHaveBeenCalled();
    });
    test("is left alone when its product is not a configured team plan", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      // An add-on product this deployment does not configure reaches the plan handlers.
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-09T23:00:00Z" },
        sub_addon: { ...TEAM_SUB, id: "sub_addon", product_id: "prod_unconfigured_addon" },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_addon")
      );

      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(mockFns.supersedeCheckoutLinks).not.toHaveBeenCalled();
      expect(teamsUpdates()).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        "[team-billing] ignored an event for a subscription the team does not hold",
        expect.objectContaining({ eventSubscriptionId: "sub_addon" })
      );
      // Kept in the audit log as well, with ids and the reason only.
      expect(mockFns.auditSystemEvent).toHaveBeenCalledWith({
        action: "team.duplicate_plan_reported",
        outcome: "refused",
        teamId: "team_1",
        targetId: "sub_addon",
        metadata: { stored_subscription_id: "sub_live", reason: "not_a_plan" },
      });
    });

    test("an older one is reported for a person, neither ended nor refunded", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      // It started before the stored one, so it may be the plan the team
      // used all along (its row cleared by a revoked event while it stayed
      // live): refunding it in full would pay back months that were used.
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-10T00:00:00Z" },
        sub_older: {
          ...TEAM_SUB,
          id: "sub_older",
          started_at: "2026-07-01T00:00:00Z",
          checkout_id: "co_older",
        },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.updated",
        "team_1",
        subscriptionEvent("sub_older")
      );

      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(mockFns.supersedeCheckoutLinks).not.toHaveBeenCalled();
      expect(teamsUpdates()).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        "[team-billing] a team has a second live team plan subscription that did not start within two hours of the one it holds",
        expect.objectContaining({ eventSubscriptionId: "sub_older" })
      );
      expect(mockFns.auditSystemEvent).toHaveBeenCalledTimes(1);
      expect(mockFns.auditSystemEvent).toHaveBeenCalledWith({
        action: "team.duplicate_plan_reported",
        outcome: "refused",
        teamId: "team_1",
        targetId: "sub_older",
        metadata: { stored_subscription_id: "sub_live", reason: "not_a_twin" },
      });
    });

    test("twin checkouts: the one that started first is ended when its event arrives second", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      // Both sessions were paid within the hour; the earlier one's event was
      // retried after a 5xx, so the later one is the subscription stored.
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-10T10:30:00Z" },
        sub_first: {
          ...TEAM_SUB,
          id: "sub_first",
          started_at: "2026-08-10T10:05:00Z",
          checkout_id: "co_first",
        },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_first")
      );

      expect(mockFns.recordRefund).toHaveBeenCalledWith({
        target: { subscription: "sub_first" },
        reason: "duplicate_plan",
        teamId: "team_1",
      });
      expect(mockFns.supersedeCheckoutLinks).toHaveBeenCalledWith(
        "co_first",
        undefined,
        CUSTOMER_OF_EVENT
      );
      expect(revoke).toHaveBeenCalledWith("sub_first");
      expect(revoke).not.toHaveBeenCalledWith("sub_live");
      expect(teamsUpdates()).toEqual([]);
      // Ended, not reported.
      expect(mockFns.auditSystemEvent).not.toHaveBeenCalled();
    });

    test("twin checkouts: the one that started second is ended when its event arrives second", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-10T10:05:00Z" },
        sub_second: {
          ...TEAM_SUB,
          id: "sub_second",
          started_at: "2026-08-10T10:30:00Z",
          checkout_id: "co_second",
        },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_second")
      );

      expect(mockFns.recordRefund).toHaveBeenCalledWith({
        target: { subscription: "sub_second" },
        reason: "duplicate_plan",
        teamId: "team_1",
      });
      expect(revoke).toHaveBeenCalledWith("sub_second");
      expect(revoke).not.toHaveBeenCalledWith("sub_live");
    });

    test("one that started more than two hours before the stored one is reported", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-10T10:00:00Z" },
        sub_early: { ...TEAM_SUB, id: "sub_early", started_at: "2026-08-10T07:30:00Z" },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.updated",
        "team_1",
        subscriptionEvent("sub_early")
      );

      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(mockFns.supersedeCheckoutLinks).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[team-billing] a team has a second live team plan subscription that did not start within two hours of the one it holds",
        expect.objectContaining({ eventSubscriptionId: "sub_early" })
      );
    });

    test("a twin is ended by when each was created when Polar left out when it started", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      // Polar left out started_at: created_at says when each began.
      const revoke = polarState({
        sub_live: {
          ...TEAM_SUB,
          id: "sub_live",
          started_at: null,
          created_at: "2026-08-02T00:00:00Z",
        },
        sub_2: { ...TEAM_SUB, id: "sub_2", started_at: null, created_at: "2026-08-02T01:00:00Z" },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_2")
      );

      expect(revoke).toHaveBeenCalledWith("sub_2");
      expect(mockFns.recordRefund).toHaveBeenCalledTimes(1);
    });

    test("one that started more than two hours after the stored one is reported, neither ended nor refunded", async () => {
      // A checkout is refused once the team is subscribed, so a real twin
      // starts within the window; one a week later is more likely a
      // replacement staff made in Polar.
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: "2026-08-01T00:00:00Z" },
        sub_late: {
          ...TEAM_SUB,
          id: "sub_late",
          started_at: "2026-08-08T00:00:00Z",
          checkout_id: "co_late",
        },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_late")
      );

      expect(revoke).not.toHaveBeenCalled();
      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(mockFns.supersedeCheckoutLinks).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[team-billing] a team has a second live team plan subscription that did not start within two hours of the one it holds",
        expect.objectContaining({ eventSubscriptionId: "sub_late" })
      );
    });

    test("is reported, not ended, when Polar left out when either started", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live", started_at: null },
        sub_2: { ...TEAM_SUB, id: "sub_2", started_at: null },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.created",
        "team_1",
        subscriptionEvent("sub_2")
      );

      expect(revoke).not.toHaveBeenCalled();
      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    });

    test("is left alone when it is on another Polar customer", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      // Not this team's customer: not a second checkout of the team's.
      const revoke = polarState({
        sub_live: { ...TEAM_SUB, id: "sub_live" },
        sub_other: { ...TEAM_SUB, id: "sub_other", customer_id: "cus_someone_else" },
        sub_none: { ...TEAM_SUB, id: "sub_none", customer_id: null },
      });

      await applyTeamPolarWebhookEvent(
        "subscription.updated",
        "team_1",
        subscriptionEvent("sub_other")
      );
      mockFns.createAdminClient.mockReturnValue(createFakeAdmin({ "teams:select": [liveTeam] }));
      await applyTeamPolarWebhookEvent(
        "subscription.updated",
        "team_1",
        subscriptionEvent("sub_none")
      );

      expect(mockFns.recordRefund).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(teamsUpdates()).toEqual([]);
    });
  });

  test("ignores events for a foreign subscription Polar does not report live", async () => {
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
        "teams:update": [{ data: [{ id: "team_1" }] }],
      })
    );

    await applyTeamPolarWebhookEvent(
      "subscription.created",
      "team_1",
      subscriptionEvent("sub_new")
    );

    // The state write, then the schedule read back from Polar.
    expect(teamsUpdates()).toHaveLength(2);
    expect(teamsUpdates()[1].payload).toMatchObject({ pending_seats: null });
    expect(teamsUpdates()[0].payload).toMatchObject({
      polar_subscription_id: "sub_new",
      subscription_status: "active",
      requests_used: 0,
      // The checkout that produced this subscription stops being reusable.
      pending_checkout: null,
    });
  });

  test("mirrors the schedule from Polar's current state, versioned by the read time", async () => {
    const liveRow = {
      data: {
        polar_subscription_id: "sub_1",
        subscription_status: "active",
        seats: 5,
        period_start: "2026-08-01T00:00:00.000Z",
      },
    };
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [liveRow],
        "teams:update": [{ data: [{ id: "team_1" }] }, {}],
      })
    );
    freezeClock();
    const get = vi.fn().mockResolvedValue({
      id: "sub_1",
      seats: 5,
      pending_update: { seats: 3, applies_at: "2026-08-31T00:00:00.000000Z" },
    });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { get } });

    await applyTeamPolarWebhookEvent(
      "subscription.updated",
      "team_1",
      subscriptionEvent("sub_1", { seats: 5, pending_update: { seats: 3 } })
    );

    // The state write keeps the paid seats; the schedule is a separate,
    // version-guarded write so an older read loses.
    expect(get).toHaveBeenCalledWith("sub_1");
    expect(teamsUpdates()[0].payload).toMatchObject({ seats: 5, request_limit: 500_000 });
    expect(teamsUpdates()[0].payload).not.toHaveProperty("pending_seats");
    expect(teamsUpdates()[1].payload).toEqual({
      pending_seats: 3,
      pending_plan: null,
      pending_interval: null,
      pending_seats_as_of: NOW.toISOString(),
    });
    const sync = recordedFilters.filter((c) => c.table === "teams" && c.op === "update")[1];
    expect(sync.filters).toContainEqual([
      "or",
      `pending_seats_as_of.is.null,pending_seats_as_of.lt."${NOW.toISOString()}"`,
      null,
    ]);
  });

  test("a schedule cleared in Polar reaches the row although modified_at did not move", async () => {
    // Polar keeps the subscription's modified_at when a pending update is
    // cleared, so a payload can still show the old schedule; the read wins.
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: "sub_1",
              subscription_status: "active",
              seats: 5,
              period_start: "2026-08-01T00:00:00.000Z",
            },
          },
        ],
        "teams:update": [{ data: [{ id: "team_1" }] }, {}],
      })
    );
    freezeClock();
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: { get: vi.fn().mockResolvedValue({ id: "sub_1", pending_update: null }) },
    });

    await applyTeamPolarWebhookEvent(
      "subscription.updated",
      "team_1",
      subscriptionEvent("sub_1", {
        modified_at: "2026-08-10T12:00:00.000000Z",
        pending_update: { seats: 3 },
      })
    );

    expect(teamsUpdates()[1].payload).toEqual({
      pending_seats: null,
      pending_plan: null,
      pending_interval: null,
      pending_seats_as_of: NOW.toISOString(),
    });
  });

  test("a failed Polar read fails the webhook so Polar redelivers it", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: "sub_1",
              subscription_status: "active",
              seats: 5,
              period_start: "2026-08-01T00:00:00.000Z",
            },
          },
        ],
        "teams:update": [{ data: [{ id: "team_1" }] }],
      })
    );
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: { get: vi.fn().mockRejectedValue(new Error("polar down")) },
    });

    await expect(
      applyTeamPolarWebhookEvent(
        "subscription.updated",
        "team_1",
        subscriptionEvent("sub_1", { pending_update: { seats: 3 } })
      )
    ).rejects.toThrow("polar down");

    // The current state is read before anything is written, so nothing is,
    // and the redelivery applies it all.
    expect(teamsUpdates()).toHaveLength(0);
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
        "teams:update": [{ data: [{ id: "team_1" }] }],
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
        "teams:update": [{ data: [{ id: "team_1" }] }],
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

  test("an annual team's yearly renewal just after the reset job opened a window keeps its usage", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: "sub_1",
              subscription_status: "active",
              seats: 3,
              business: true,
              billing_interval: "year",
              billing_period_end: "2028-01-31T10:00:00.000Z",
              period_start: "2028-01-28T10:00:00.000Z",
              period_end: "2028-02-29T10:00:00.000Z",
            },
          },
        ],
        "teams:update": [{ data: [{ id: "team_1" }] }, {}],
      })
    );

    await applyTeamPolarWebhookEvent(
      "subscription.updated",
      "team_1",
      subscriptionEvent("sub_1", {
        product_id: "prod_team_business_year_123",
        current_period_start: "2028-01-31T10:00:00.000Z",
        current_period_end: "2029-01-31T10:00:00.000Z",
      })
    );

    const payload = teamsUpdates()[0].payload;
    expect(payload).toMatchObject({
      billing_period_end: "2029-01-31T10:00:00.000Z",
      period_end: "2028-02-29T10:00:00.000Z",
    });
    // The window keeps its start (Jan 28), which the parsed pages count from.
    expect((payload as Record<string, unknown>).period_start).toBeUndefined();
    expect(payload).not.toHaveProperty("requests_used");
  });

  test("an annual team's yearly renewal a month after the last reset starts a fresh window", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: "sub_1",
              subscription_status: "active",
              seats: 3,
              business: true,
              billing_interval: "year",
              billing_period_end: "2028-01-31T10:00:00.000Z",
              period_start: "2027-12-31T10:00:00.000Z",
              period_end: "2028-01-31T10:00:00.000Z",
            },
          },
        ],
        "teams:update": [{ data: [{ id: "team_1" }] }, {}],
      })
    );

    await applyTeamPolarWebhookEvent(
      "subscription.updated",
      "team_1",
      subscriptionEvent("sub_1", {
        product_id: "prod_team_business_year_123",
        current_period_start: "2028-01-31T10:00:00.000Z",
        current_period_end: "2029-01-31T10:00:00.000Z",
      })
    );

    expect(teamsUpdates()[0].payload).toMatchObject({
      period_start: "2028-01-31T10:00:00.000Z",
      period_end: "2028-02-29T10:00:00.000Z",
      requests_used: 0,
    });
  });

  test("a product this deployment does not know keeps the team's plan", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: "sub_1",
              subscription_status: "active",
              seats: 3,
              period_start: "2026-08-01T00:00:00.000Z",
              business: true,
              billing_interval: "year",
            },
          },
        ],
        "teams:update": [{ data: [{ id: "team_1" }] }, {}],
      })
    );

    await applyTeamPolarWebhookEvent(
      "subscription.updated",
      "team_1",
      subscriptionEvent("sub_1", { product_id: "prod_unknown" })
    );

    expect(teamsUpdates()[0].payload).toMatchObject({
      business: true,
      billing_interval: "year",
    });
  });

  test("an ended or unpaid subscription does not open an inactive team", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inactive = {
      data: {
        polar_subscription_id: null,
        subscription_status: null,
        seats: 3,
        period_start: null,
      },
    };
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "teams:select": [inactive, inactive] })
    );

    await applyTeamPolarWebhookEvent(
      "subscription.created",
      "team_1",
      subscriptionEvent("sub_new", { status: "canceled", ended_at: "2026-08-02T00:00:00Z" })
    );
    await applyTeamPolarWebhookEvent(
      "subscription.created",
      "team_1",
      subscriptionEvent("sub_new", { status: "incomplete" })
    );

    expect(teamsUpdates()).toEqual([]);
  });

  test("a late event for an ended subscription does not bring it back to a complimentary team", async () => {
    // A staff team whose paid subscription was revoked is live again with
    // no stored id; only a new subscription (created) may take it over.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const complimentary = {
      data: {
        polar_subscription_id: null,
        subscription_status: "active",
        seats: 10,
        period_start: "2026-08-01T00:00:00.000Z",
        business: true,
        billing_interval: "month",
      },
    };
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({ "teams:select": [complimentary, complimentary, complimentary] })
    );

    await applyTeamPolarWebhookEvent(
      "subscription.updated",
      "team_1",
      subscriptionEvent("sub_old")
    );
    await applyTeamPolarWebhookEvent("subscription.active", "team_1", subscriptionEvent("sub_old"));
    await applyTeamPolarWebhookEvent(
      "subscription.created",
      "team_1",
      subscriptionEvent("sub_old", { status: "canceled", ended_at: "2026-08-02T00:00:00Z" })
    );

    expect(teamsUpdates()).toEqual([]);
  });

  test("a write that lost to another fails, so Polar delivers the event again", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          {
            data: {
              polar_subscription_id: "sub_1",
              subscription_status: "active",
              seats: 3,
              period_start: "2026-08-01T00:00:00.000Z",
              business: false,
              billing_interval: "month",
            },
          },
        ],
        "teams:update": [{ data: [] }],
      })
    );

    await expect(
      applyTeamPolarWebhookEvent("subscription.updated", "team_1", subscriptionEvent("sub_1"))
    ).rejects.toMatchObject({ code: "concurrent_update" });

    // The plan read with the row is part of the guard: a product switch keeps
    // the subscription id and the period.
    const update = recordedFilters.find((c) => c.table === "teams" && c.op === "update");
    expect(update!.filters).toContainEqual(["eq", "business", false]);
    expect(update!.filters).toContainEqual(["eq", "billing_interval", "month"]);
    // Nothing else was written: the schedule waits for the redelivery.
    expect(teamsUpdates()).toHaveLength(1);
  });

  test("terminal transitions are conditioned on the live subscription id", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "teams:select": [
          { data: { polar_subscription_id: "sub_1" } },
          { data: { polar_subscription_id: "sub_1" } },
        ],
        "teams:update": [{ data: [{ id: "team_1" }] }, {}],
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
        customer: { metadata: { teamId: "team_1" }, external_id: "team:other" },
      })
    ).toBe("team_1");
  });

  test("strips the team prefix from the customer external id", () => {
    expect(extractTeamIdFromWebhook({ customer: { external_id: "team:team_2" } })).toBe("team_2");
  });

  test("returns null for a personal customer", () => {
    expect(
      extractTeamIdFromWebhook({
        customer: { external_id: "user_1", metadata: { userId: "user_1" } },
      })
    ).toBeNull();
  });

  test("routes seat events by their seat metadata", () => {
    expect(extractTeamIdFromWebhook({ id: "seat_1", seat_metadata: { teamId: "team_3" } })).toBe(
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

describe("seat minimum", () => {
  test("refuses fewer than two seats, except the one a team already has", async () => {
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP, OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({ polar_subscription_id: "sub_1", seats: 3, pending_seats: null }),
          teamRow({ polar_subscription_id: "sub_1", seats: 1, pending_seats: null }),
        ],
      })
    );

    await expect(updateTeamSeats("user_1", "team_1", 1)).rejects.toMatchObject({
      code: "invalid_seats",
    });
    // A team subscribed with one seat before the minimum keeps it: asking for
    // its own count changes nothing.
    await expect(updateTeamSeats("user_1", "team_1", 1)).resolves.toBeUndefined();
    expect(mockFns.createPolarClient).not.toHaveBeenCalled();
  });

  test("a checkout needs two seats", async () => {
    await expect(createTeamCheckout("user_1", "team_1", 1)).rejects.toMatchObject({
      code: "invalid_seats",
    });
  });
});

describe("changeTeamPlan", () => {
  const subscribed = (overrides: Record<string, unknown> = {}) =>
    teamRow({
      polar_subscription_id: "sub_1",
      subscription_status: "active",
      seats: 2,
      business: false,
      billing_interval: "month",
      pending_plan: null,
      pending_interval: null,
      pending_seats: null,
      ...overrides,
    });

  function admin(team: QueryResult, extra: Record<string, QueryResult[]> = {}) {
    return createFakeAdmin({
      "team_members:select": [OWNER_MEMBERSHIP],
      "teams:select": [team],
      ...extra,
    });
  }

  test("an upgrade switches the product now and charges the difference", async () => {
    freezeClock();
    mockFns.createAdminClient.mockReturnValue(
      admin(subscribed(), {
        // The owner check, then the row the state write is guarded on.
        "teams:select": [
          subscribed(),
          {
            data: {
              polar_subscription_id: "sub_1",
              subscription_status: "active",
              seats: 2,
              period_start: "2026-10-01T00:00:00.000Z",
              period_end: "2026-10-31T00:00:00.000Z",
              business: false,
              billing_interval: "month",
              billing_period_end: "2026-10-31T00:00:00.000Z",
              prorated_window: null,
            },
          },
        ],
        "teams:update": [{ data: [{ id: "team_1" }] }, {}],
      })
    );
    const update = vi.fn().mockResolvedValue({
      id: "sub_1",
      product_id: "prod_team_business_123",
      seats: 2,
      status: "active",
      current_period_start: "2026-10-01T00:00:00.000Z",
      current_period_end: "2026-10-31T00:00:00.000Z",
    });
    const get = vi.fn().mockResolvedValue({ id: "sub_1", pending_update: null });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update, get } });

    await expect(changeTeamPlan("user_1", "team_1", "team_business", "month")).resolves.toEqual({
      applied: "now",
    });
    expect(update).toHaveBeenCalledWith("sub_1", {
      product_id: "prod_team_business_123",
      proration_behavior: "invoice",
    });
    // The new plan is written at once, not only when the webhook arrives.
    expect(recorded).toContainEqual(
      expect.objectContaining({
        table: "teams",
        op: "update",
        payload: expect.objectContaining({ business: true, billing_interval: "month" }),
      })
    );
  });

  test("an upgrade schedules a pending seat reduction again, since the switch clears it", async () => {
    freezeClock();
    mockFns.createAdminClient.mockReturnValue(admin(subscribed({ seats: 4, pending_seats: 3 })));
    const update = vi
      .fn()
      .mockResolvedValueOnce({ id: "sub_1", product_id: "prod_team_business_123", seats: 4 })
      .mockResolvedValueOnce({
        id: "sub_1",
        product_id: "prod_team_business_123",
        seats: 4,
        pending_update: { product_id: null, seats: 3 },
      });
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: { update, get: vi.fn().mockResolvedValue({ id: "sub_1" }) },
    });

    await expect(changeTeamPlan("user_1", "team_1", "team_business", "month")).resolves.toEqual({
      applied: "now",
    });
    expect(update).toHaveBeenNthCalledWith(2, "sub_1", {
      seats: 3,
      proration_behavior: "next_period",
    });
  });

  test("an upgrade says so when the seat reduction cannot be scheduled again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFns.createAdminClient.mockReturnValue(admin(subscribed({ seats: 4, pending_seats: 3 })));
    const update = vi
      .fn()
      .mockResolvedValueOnce({ id: "sub_1", product_id: "prod_team_business_123", seats: 4 })
      .mockRejectedValueOnce(new Error("polar down"));
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: { update, get: vi.fn().mockResolvedValue({ id: "sub_1" }) },
    });

    await expect(changeTeamPlan("user_1", "team_1", "team_business", "month")).resolves.toEqual({
      applied: "now",
      seatReductionLost: 3,
    });
  });

  test("a move to annual applies now, a move down waits for the renewal", async () => {
    freezeClock();
    const update = vi.fn().mockResolvedValue({
      id: "sub_1",
      product_id: "prod_team_business_123",
      pending_update: { product_id: "prod_teams_123", seats: null },
    });
    mockFns.createPolarClient.mockReturnValue({
      subscriptions: { update, get: vi.fn().mockResolvedValue({ id: "sub_1" }) },
    });

    mockFns.createAdminClient.mockReturnValue(admin(subscribed({ business: true })));
    await expect(changeTeamPlan("user_1", "team_1", "team_business", "year")).resolves.toEqual({
      applied: "now",
    });
    expect(update).toHaveBeenLastCalledWith("sub_1", {
      product_id: "prod_team_business_year_123",
      proration_behavior: "invoice",
    });

    recorded = [];
    mockFns.createAdminClient.mockReturnValue(admin(subscribed({ business: true })));
    await expect(changeTeamPlan("user_1", "team_1", "team", "month")).resolves.toEqual({
      applied: "renewal",
    });
    expect(update).toHaveBeenLastCalledWith("sub_1", {
      product_id: "prod_teams_123",
      proration_behavior: "next_period",
    });
    // Polar's pending update is mirrored with the time it was confirmed.
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: {
        pending_seats: null,
        pending_plan: "team",
        pending_interval: "month",
        pending_seats_as_of: NOW.toISOString(),
      },
    });
  });

  test("refuses what Polar would refuse or what needs another step first", async () => {
    const update = vi.fn();
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update } });

    mockFns.createAdminClient.mockReturnValue(admin(subscribed({ seats: 1 })));
    await expect(
      changeTeamPlan("user_1", "team_1", "team_business", "month")
    ).rejects.toMatchObject({ code: "seats_below_minimum" });

    mockFns.createAdminClient.mockReturnValue(
      admin(subscribed({ business: true, pending_plan: "team", pending_interval: "month" }))
    );
    await expect(changeTeamPlan("user_1", "team_1", "team_business", "year")).rejects.toMatchObject(
      { code: "change_pending" }
    );

    mockFns.createAdminClient.mockReturnValue(admin(subscribed({ cancel_at_period_end: true })));
    await expect(
      changeTeamPlan("user_1", "team_1", "team_business", "month")
    ).rejects.toMatchObject({ code: "plan_ending" });

    mockFns.createAdminClient.mockReturnValue(admin(subscribed()));
    await expect(changeTeamPlan("user_1", "team_1", "team", "month")).rejects.toMatchObject({
      code: "unchanged",
    });

    // Teams is monthly only.
    await expect(changeTeamPlan("user_1", "team_1", "team", "year")).rejects.toMatchObject({
      code: "not_offered",
    });
    expect(update).not.toHaveBeenCalled();
  });

  test("a declined card changes nothing", async () => {
    const declined = Object.create(errors.SubscriptionsUpdate402Error.prototype) as {
      error: { error: string };
    };
    declined.error = { error: "PaymentFailed" };
    const update = vi.fn().mockRejectedValue(declined);
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update } });
    mockFns.createAdminClient.mockReturnValue(admin(subscribed()));

    await expect(
      changeTeamPlan("user_1", "team_1", "team_business", "month")
    ).rejects.toMatchObject({ code: "payment_failed" });
    expect(recorded.filter((call) => call.op === "update")).toEqual([]);
  });

  test("a payment the bank wants confirmed has its own code", async () => {
    const action = Object.create(errors.SubscriptionsUpdate402Error.prototype) as {
      error: { error: string };
    };
    action.error = { error: "PaymentActionRequired" };
    const update = vi.fn().mockRejectedValue(action);
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update } });
    mockFns.createAdminClient.mockReturnValue(admin(subscribed()));

    await expect(
      changeTeamPlan("user_1", "team_1", "team_business", "month")
    ).rejects.toMatchObject({ code: "payment_action_required" });
  });

  test("an approved switch made now refuses before Polar within a minute of the period end", async () => {
    const update = vi.fn();
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update } });
    mockFns.createAdminClient.mockReturnValue(admin(subscribed()));
    const soon = new Date(Date.now() + 30_000).toISOString();
    await expect(
      changeTeamPlan("user_1", "team_1", "team_business", "month", { periodEnd: soon })
    ).rejects.toMatchObject({ code: "quote_changed" });
    mockFns.createAdminClient.mockReturnValue(admin(subscribed()));
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await expect(
      changeTeamPlan("user_1", "team_1", "team_business", "month", { periodEnd: past })
    ).rejects.toMatchObject({ code: "quote_changed" });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("keepTeamPlan", () => {
  test("clears Polar's pending update and schedules a seat reduction again", async () => {
    freezeClock();
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({
            polar_subscription_id: "sub_1",
            subscription_status: "active",
            seats: 4,
            business: true,
            pending_plan: "team",
            pending_interval: "month",
            pending_seats: 3,
          }),
        ],
      })
    );
    const update = vi
      .fn()
      .mockResolvedValueOnce({ id: "sub_1", pending_update: null })
      .mockResolvedValueOnce({ id: "sub_1", pending_update: { product_id: null, seats: 3 } });
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update } });

    await keepTeamPlan("user_1", "team_1");
    expect(update).toHaveBeenNthCalledWith(1, "sub_1", { pending_update: null });
    expect(update).toHaveBeenNthCalledWith(2, "sub_1", {
      seats: 3,
      proration_behavior: "next_period",
    });
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: {
        pending_seats: 3,
        pending_plan: null,
        pending_interval: null,
        pending_seats_as_of: NOW.toISOString(),
      },
    });
  });
});

describe("keepTeamPlan when Polar drops the seat reduction", () => {
  test("keeps the plan and says the reduction has to be set again", async () => {
    freezeClock();
    mockFns.createAdminClient.mockReturnValue(
      createFakeAdmin({
        "team_members:select": [OWNER_MEMBERSHIP],
        "teams:select": [
          teamRow({
            polar_subscription_id: "sub_1",
            subscription_status: "active",
            seats: 4,
            business: true,
            pending_plan: "team",
            pending_interval: "month",
            pending_seats: 3,
          }),
        ],
      })
    );
    const update = vi
      .fn()
      .mockResolvedValueOnce({ id: "sub_1", pending_update: null })
      .mockRejectedValueOnce(new Error("polar down"));
    mockFns.createPolarClient.mockReturnValue({ subscriptions: { update } });

    await expect(keepTeamPlan("user_1", "team_1")).rejects.toMatchObject({
      code: "seat_reduction_lost",
    });
    // What Polar holds now is recorded all the same.
    expect(recorded).toContainEqual({
      table: "teams",
      op: "update",
      payload: {
        pending_seats: null,
        pending_plan: null,
        pending_interval: null,
        pending_seats_as_of: NOW.toISOString(),
      },
    });
  });
});
