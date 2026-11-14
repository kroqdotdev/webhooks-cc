import { beforeEach, describe, expect, it, vi } from "vitest";

/** One query the fake admin client was asked: its table, operation and filters. */
interface Query {
  table: string;
  op: string | null;
  patch?: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
}

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  queries: [] as Query[],
  /** What each query resolves to, in order; { data: null, error: null } when empty. */
  results: [] as Array<{ data: unknown; error: unknown }>,
  createPlanCheckoutSession: vi.fn(),
  createTeamCheckoutSession: vi.fn(),
  createOneTimeBlocksCheckoutSession: vi.fn(),
  createMonthlyBlocksCheckoutSession: vi.fn(),
  createOverageCheckoutSession: vi.fn(),
  assertCanManage: vi.fn(),
  checkoutsGet: vi.fn(),
}));

function builder(table: string) {
  const query: Query = { table, op: null, filters: [] };
  mocks.queries.push(query);
  const chain: Record<string, unknown> = {};
  const filter = (kind: string) => (column: string, value: unknown) => {
    query.filters.push([kind, column, value]);
    return chain;
  };
  Object.assign(chain, {
    select: () => {
      query.op ??= "select";
      return chain;
    },
    update: (patch: Record<string, unknown>) => {
      query.op = "update";
      query.patch = patch;
      return chain;
    },
    delete: () => {
      query.op = "delete";
      return chain;
    },
    eq: filter("eq"),
    neq: filter("neq"),
    in: filter("in"),
    maybeSingle: () => Promise.resolve(mocks.results.shift() ?? { data: null, error: null }),
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(mocks.results.shift() ?? { data: null, error: null }).then(resolve, reject),
  });
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mocks.rpc, from: (table: string) => builder(table) }),
}));
vi.mock("@/lib/polar", () => ({
  createPolarClient: () => ({ checkouts: { get: mocks.checkoutsGet } }),
  loggablePolarError: (error: unknown) => ({ name: String(error) }),
  polarAppUrl: () => "https://webhooks.cc",
}));
vi.mock("@/lib/supabase/billing", () => ({
  createPlanCheckoutSession: mocks.createPlanCheckoutSession,
}));
vi.mock("@/lib/supabase/team-billing", () => ({
  createTeamCheckoutSession: mocks.createTeamCheckoutSession,
}));
vi.mock("@/lib/supabase/capacity-billing", () => ({
  assertCanManage: mocks.assertCanManage,
  createOneTimeBlocksCheckoutSession: mocks.createOneTimeBlocksCheckoutSession,
  createMonthlyBlocksCheckoutSession: mocks.createMonthlyBlocksCheckoutSession,
  createOverageCheckoutSession: mocks.createOverageCheckoutSession,
}));

import {
  CheckoutLinkError,
  checkoutSummary,
  createCheckoutLink,
  getCheckoutLink,
  parseCheckoutItem,
  settleCheckoutLinkFromWebhook,
} from "./checkout-links";

const LINK = "11111111-2222-4333-8444-555555555555";
const TEAM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SUCCESS = "https://webhooks.cc/checkout/complete";
const session = {
  id: "polar_checkout_1",
  url: "https://polar.sh/checkout/polar_c_x",
  expiresAt: "2026-11-14T13:00:00.000Z",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK,
    user_id: "user-1",
    team_id: null,
    created_by: "user-1",
    requested_by_key: "key-1",
    requested_by_agent: null,
    kind: "plan",
    item: { kind: "plan", plan: "pro", interval: "month" },
    polar_checkout_id: session.id,
    url: session.url,
    status: "open",
    created_at: "2026-11-14T12:00:00.000Z",
    expires_at: session.expiresAt,
    paid_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  mocks.results.length = 0;
  mocks.rpc.mockResolvedValue({ data: LINK, error: null });
  mocks.assertCanManage.mockResolvedValue(undefined);
});

describe("parseCheckoutItem", () => {
  it("takes each kind with its defaults", () => {
    expect(parseCheckoutItem({ kind: "plan", plan: "business" })).toEqual({
      ok: true,
      item: { kind: "plan", plan: "business", interval: "month" },
    });
    expect(parseCheckoutItem({ kind: "team_plan", teamId: TEAM, seats: 3 })).toEqual({
      ok: true,
      item: { kind: "team_plan", teamId: TEAM, seats: 3, plan: "team", interval: "month" },
    });
    expect(parseCheckoutItem({ kind: "blocks", blocks: 2 })).toMatchObject({
      ok: true,
      item: { resource: "requests" },
    });
    expect(parseCheckoutItem({ kind: "overage", resource: "pages", teamId: TEAM })).toMatchObject({
      ok: true,
    });
  });

  it("refuses unknown kinds, fields, team ids and counts outside the limits", () => {
    expect(parseCheckoutItem({ kind: "portal" }).ok).toBe(false);
    expect(parseCheckoutItem(null).ok).toBe(false);
    expect(parseCheckoutItem({ kind: "plan", plan: "pro", extra: 1 }).ok).toBe(false);
    expect(parseCheckoutItem({ kind: "team_plan", teamId: "../x", seats: 3 }).ok).toBe(false);
    expect(parseCheckoutItem({ kind: "team_plan", teamId: TEAM, seats: 1 }).ok).toBe(false);
    expect(parseCheckoutItem({ kind: "blocks", blocks: 0 }).ok).toBe(false);
    expect(parseCheckoutItem({ kind: "blocks", blocks: 401 }).ok).toBe(false);
    expect(parseCheckoutItem({ kind: "monthly_blocks", blocks: 20, resource: "domains" }).ok).toBe(
      false
    );
    // Domains are monthly only, and overage has no maximum to set here.
    expect(parseCheckoutItem({ kind: "blocks", blocks: 1, resource: "domains" }).ok).toBe(false);
    expect(parseCheckoutItem({ kind: "overage", maxBlocks: 100 }).ok).toBe(false);
  });

  it("says what each kind buys", () => {
    expect(checkoutSummary({ kind: "plan", plan: "pro", interval: "year" })).toBe(
      "The Pro plan, billed yearly."
    );
    expect(
      checkoutSummary({ kind: "monthly_blocks", blocks: 1, resource: "domains", teamId: TEAM })
    ).toContain("1 monthly extra custom domain in all for the team");
  });
});

describe("createCheckoutLink", () => {
  it("takes a slot, opens the checkout with the public success page and records it", async () => {
    mocks.createPlanCheckoutSession.mockResolvedValue(session);
    mocks.results.push({ data: row(), error: null });

    const link = await createCheckoutLink(
      { userId: "user-1", keyId: "key-1", agentRegistrationId: null },
      { kind: "plan", plan: "pro", interval: "month" }
    );

    expect(mocks.rpc).toHaveBeenCalledWith("reserve_billing_checkout", {
      p_user_id: "user-1",
      p_team_id: null,
      p_created_by: "user-1",
      p_key_id: "key-1",
      p_agent_id: null,
      p_kind: "plan",
      p_item: { kind: "plan", plan: "pro", interval: "month" },
    });
    expect(mocks.createPlanCheckoutSession).toHaveBeenCalledWith("user-1", "pro", "month", {
      successUrl: SUCCESS,
    });
    expect(mocks.queries[0]).toMatchObject({
      table: "billing_checkouts",
      op: "update",
      patch: { polar_checkout_id: session.id, status: "open", expires_at: session.expiresAt },
    });
    expect(link).toMatchObject({
      id: LINK,
      status: "open",
      url: session.url,
      summary: "The Pro plan, billed monthly.",
      teamId: null,
    });
  });

  it("bills a team's purchase to the team, only once its owner is checked", async () => {
    mocks.createOneTimeBlocksCheckoutSession.mockResolvedValue(session);
    mocks.results.push({
      data: row({ user_id: null, team_id: TEAM, kind: "blocks", item: { kind: "blocks" } }),
      error: null,
    });
    await createCheckoutLink(
      { userId: "owner-1" },
      { kind: "blocks", blocks: 2, resource: "requests", teamId: TEAM }
    );
    expect(mocks.assertCanManage).toHaveBeenCalledWith({ kind: "team", teamId: TEAM }, "owner-1");
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_user_id: null, p_team_id: TEAM });
    expect(mocks.createOneTimeBlocksCheckoutSession).toHaveBeenCalledWith(
      { kind: "team", teamId: TEAM },
      "owner-1",
      2,
      "requests",
      { successUrl: SUCCESS }
    );
  });

  it("refuses a team member before taking a slot", async () => {
    const notOwner = new Error("Only the team owner can do this");
    mocks.assertCanManage.mockRejectedValue(notOwner);
    await expect(
      createCheckoutLink(
        { userId: "member-1" },
        { kind: "team_plan", teamId: TEAM, seats: 3, plan: "team", interval: "month" }
      )
    ).rejects.toBe(notOwner);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createTeamCheckoutSession).not.toHaveBeenCalled();
  });

  it("answers the limits as refusals", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "checkout_links_hourly_limit" },
    });
    const hourly = await createCheckoutLink(
      { userId: "user-1" },
      { kind: "plan", plan: "pro", interval: "month" }
    ).catch((e: unknown) => e);
    expect(hourly).toBeInstanceOf(CheckoutLinkError);
    expect((hourly as CheckoutLinkError).status).toBe(429);

    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "checkout_links_open_limit" },
    });
    const open = await createCheckoutLink(
      { userId: "user-1" },
      { kind: "plan", plan: "pro", interval: "month" }
    ).catch((e: unknown) => e);
    expect((open as CheckoutLinkError).status).toBe(409);
    expect(mocks.createPlanCheckoutSession).not.toHaveBeenCalled();
  });

  it("gives the slot back when the checkout is refused", async () => {
    const refused = new Error("You already have a plan; change it instead");
    mocks.createPlanCheckoutSession.mockRejectedValue(refused);
    await expect(
      createCheckoutLink({ userId: "user-1" }, { kind: "plan", plan: "pro", interval: "month" })
    ).rejects.toBe(refused);
    expect(mocks.queries[0]).toMatchObject({
      op: "delete",
      filters: [
        ["eq", "id", LINK],
        ["eq", "status", "creating"],
      ],
    });
  });

  it("answers the link that already follows a reused team session", async () => {
    mocks.createTeamCheckoutSession.mockResolvedValue(session);
    mocks.results.push({ data: null, error: { code: "23505", message: "duplicate key" } });
    mocks.results.push({ data: null, error: null }); // the slot's delete
    mocks.results.push({
      data: row({ id: "earlier", team_id: TEAM, user_id: null, kind: "team_plan" }),
      error: null,
    });
    const link = await createCheckoutLink(
      { userId: "owner-1" },
      { kind: "team_plan", teamId: TEAM, seats: 4, plan: "team", interval: "month" }
    );
    expect(link.id).toBe("earlier");
    expect(mocks.queries[1].op).toBe("delete");
    expect(mocks.queries[2]).toMatchObject({
      op: "update",
      patch: { kind: "team_plan", item: { seats: 4 } },
      filters: [
        ["eq", "polar_checkout_id", session.id],
        ["eq", "created_by", "owner-1"],
      ],
    });
  });
});

describe("getCheckoutLink", () => {
  it("reads only the asker's own links, without the url once it is no longer open", async () => {
    mocks.results.push({
      data: row({ status: "paid", paid_at: "2026-11-14T12:05:00Z" }),
      error: null,
    });
    const link = await getCheckoutLink(LINK, "user-1");
    expect(mocks.queries[0].filters).toEqual([
      ["eq", "id", LINK],
      ["eq", "created_by", "user-1"],
      ["neq", "status", "creating"],
    ]);
    expect(link).toMatchObject({ status: "paid", url: null });
  });

  it("settles an open link past its expiry from Polar", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T14:00:00Z"));
    try {
      mocks.results.push({ data: row(), error: null });
      mocks.checkoutsGet.mockResolvedValue({ status: "expired" });
      mocks.results.push({ data: [row({ status: "expired" })], error: null });
      expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "expired" });
      expect(mocks.queries[1]).toMatchObject({ op: "update", patch: { status: "expired" } });

      mocks.results.push({ data: row(), error: null });
      mocks.checkoutsGet.mockResolvedValue({ status: "succeeded" });
      mocks.results.push({ data: [row({ status: "paid" })], error: null });
      expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "paid" });

      // Polar unreachable: still open, and asked again on the next read.
      mocks.results.push({ data: row(), error: null });
      mocks.checkoutsGet.mockRejectedValue(new Error("down"));
      expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("settleCheckoutLinkFromWebhook", () => {
  it("marks a link paid by its checkout's order or live subscription", async () => {
    await settleCheckoutLinkFromWebhook("order.paid", {
      id: "o1",
      checkout_id: "polar_checkout_1",
    });
    expect(mocks.queries[0]).toMatchObject({
      op: "update",
      patch: { status: "paid" },
      filters: [
        ["eq", "polar_checkout_id", "polar_checkout_1"],
        ["in", "status", ["creating", "open", "expired"]],
      ],
    });

    await settleCheckoutLinkFromWebhook("subscription.created", {
      checkout_id: "polar_checkout_2",
      status: "active",
    });
    expect(mocks.queries).toHaveLength(2);
    // An incomplete subscription has not been paid.
    await settleCheckoutLinkFromWebhook("subscription.created", {
      checkout_id: "polar_checkout_3",
      status: "incomplete",
    });
    expect(mocks.queries).toHaveLength(2);
  });

  it("expires a link only while it is open, and ignores everything else", async () => {
    await settleCheckoutLinkFromWebhook("checkout.updated", { id: "c1", status: "expired" });
    expect(mocks.queries[0]).toMatchObject({
      patch: { status: "expired" },
      filters: [
        ["eq", "polar_checkout_id", "c1"],
        ["eq", "status", "open"],
      ],
    });
    await settleCheckoutLinkFromWebhook("checkout.updated", { id: "c1", status: "confirmed" });
    await settleCheckoutLinkFromWebhook("order.paid", { id: "o2", checkout_id: null });
    await settleCheckoutLinkFromWebhook("customer.updated", { id: "cus" });
    expect(mocks.queries).toHaveLength(1);
  });
});
