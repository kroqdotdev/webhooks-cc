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
  planPurchase: vi.fn(),
  teamPlanPurchase: vi.fn(),
  teamCheckoutBlocked: vi.fn(),
  oneTimeBlocksPurchase: vi.fn(),
  monthlyBlocksPurchase: vi.fn(),
  overagePurchase: vi.fn(),
  assertCanManage: vi.fn(),
  getTeamForOwner: vi.fn(),
  checkoutsGet: vi.fn(),
  subscriptionsGet: vi.fn(),
  accountHomeOrigin: vi.fn(),
  mint: vi.fn(),
  reportError: vi.fn(),
}));

function builder(table: string) {
  const query: Query = { table, op: null, filters: [] };
  mocks.queries.push(query);
  const chain: Record<string, unknown> = {};
  const filter = (kind: string) => (column: string, value: unknown) => {
    query.filters.push([kind, column, value]);
    return chain;
  };
  const settle = () => Promise.resolve(mocks.results.shift() ?? { data: null, error: null });
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
    eq: filter("eq"),
    neq: filter("neq"),
    in: filter("in"),
    is: filter("is"),
    lte: filter("lte"),
    contains: filter("contains"),
    filter: (column: string, operator: string, value: unknown) => {
      query.filters.push(["filter", column, `${operator}.${String(value)}`]);
      return chain;
    },
    or: (expression: string) => {
      query.filters.push(["or", expression, null]);
      return chain;
    },
    maybeSingle: settle,
    single: settle,
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      settle().then(resolve, reject),
  });
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mocks.rpc, from: (table: string) => builder(table) }),
}));
vi.mock("@/lib/polar", () => ({
  createPolarClient: () => ({
    checkouts: { get: mocks.checkoutsGet },
    subscriptions: { get: mocks.subscriptionsGet },
  }),
  isEndedSubscriptionError: () => false,
  loggablePolarError: (error: unknown) => ({ name: String(error) }),
}));
vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }));
vi.mock("@/lib/supabase/home-site", () => ({ accountHomeOrigin: mocks.accountHomeOrigin }));
vi.mock("@/lib/supabase/billing", () => {
  class BillingActionError extends Error {
    constructor(
      public code: string,
      message: string
    ) {
      super(message);
    }
  }
  return { BillingActionError, planPurchase: mocks.planPurchase };
});
vi.mock("@/lib/supabase/team-billing", () => {
  class TeamBillingError extends Error {
    constructor(
      public code: string,
      message: string
    ) {
      super(message);
    }
  }
  return {
    TeamBillingError,
    teamPlanPurchase: mocks.teamPlanPurchase,
    teamCheckoutBlocked: mocks.teamCheckoutBlocked,
    getTeamForOwner: mocks.getTeamForOwner,
  };
});
vi.mock("@/lib/supabase/capacity-billing", () => ({
  CapacityError: class CapacityError extends Error {},
  assertCanManage: mocks.assertCanManage,
  oneTimeBlocksPurchase: mocks.oneTimeBlocksPurchase,
  monthlyBlocksPurchase: mocks.monthlyBlocksPurchase,
  overagePurchase: mocks.overagePurchase,
}));

import { TeamBillingError } from "@/lib/supabase/team-billing";
import {
  boughtMatches,
  mergeBought,
  checkoutPrice,
  CheckoutLinkError,
  checkoutSummary,
  cleanAskerName,
  createCheckoutLink,
  expireCheckoutLink,
  getCheckoutLink,
  openCheckoutLink,
  parseCheckoutItem,
  reviewCheckoutLink,
  settleCheckoutLinkFromWebhook,
} from "./checkout-links";

const LINK = "11111111-2222-4333-8444-555555555555";
const TEAM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OUR_URL = `https://webhooks.cc/checkout/${LINK}`;
const POLAR_URL = "https://sandbox.polar.sh/checkout/polar_c_x";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";
const session = { id: "polar_checkout_1", url: POLAR_URL, expiresAt: FUTURE };
const PRO = { product: "prod_pro" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK,
    user_id: "user-1",
    team_id: null,
    created_by: "user-1",
    requested_by_key: "key-1",
    requested_by_agent: null,
    network: null,
    country: null,
    kind: "plan",
    item: { kind: "plan", plan: "pro", interval: "month" },
    url: OUR_URL,
    polar_checkout_id: null,
    paid_checkout_id: null,
    previous_checkout_ids: [],
    expected: null,
    bought: null,
    mismatch: null,
    detached_at: null,
    cancelled_at: null,
    opening_at: null,
    opened_at: null,
    polar_checked_at: null,
    status: "open",
    expired_reason: null,
    created_at: "2026-11-14T12:00:00.000Z",
    expires_at: FUTURE,
    paid_at: null,
    ...overrides,
  };
}

/** What linkCustomerMatches() reads: the link's account, then its Polar customer. */
function pushCustomer(customer: string | null = "cus_1") {
  mocks.results.push({ data: { user_id: "user-1", team_id: null }, error: null });
  mocks.results.push({ data: { polar_customer_id: customer }, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  mocks.results.length = 0;
  mocks.subscriptionsGet.mockReset();
  mocks.rpc.mockResolvedValue({ data: LINK, error: null });
  mocks.assertCanManage.mockResolvedValue(undefined);
  mocks.getTeamForOwner.mockResolvedValue({ id: TEAM });
  mocks.teamCheckoutBlocked.mockResolvedValue(null);
  mocks.accountHomeOrigin.mockResolvedValue("https://webhooks.cc");
  mocks.mint.mockResolvedValue(session);
  const purchase = { expected: PRO, mint: mocks.mint };
  mocks.planPurchase.mockResolvedValue(purchase);
  mocks.teamPlanPurchase.mockResolvedValue({
    expected: { product: "prod_teams", seats: 3 },
    mint: mocks.mint,
  });
  mocks.oneTimeBlocksPurchase.mockResolvedValue(purchase);
  mocks.monthlyBlocksPurchase.mockResolvedValue(purchase);
  mocks.overagePurchase.mockResolvedValue({ ...purchase, max: 250_000 });
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
  it("checks the purchase and makes the link without touching Polar", async () => {
    mocks.results.push({ data: row(), error: null });
    const link = await createCheckoutLink(
      {
        userId: "user-1",
        keyId: "key-1",
        agentRegistrationId: null,
        network: "203.0.113.0/24",
        country: "DK",
      },
      { kind: "plan", plan: "pro", interval: "month" }
    );
    expect(mocks.planPurchase).toHaveBeenCalledWith("user-1", "pro", "month");
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.checkoutsGet).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("reserve_billing_checkout", {
      p_user_id: "user-1",
      p_team_id: null,
      p_created_by: "user-1",
      p_key_id: "key-1",
      p_agent_id: null,
      p_kind: "plan",
      p_item: { kind: "plan", plan: "pro", interval: "month" },
      p_origin: "https://webhooks.cc",
      // Where the asker was, for the page's warning.
      p_network: "203.0.113.0/24",
      p_country: "DK",
    });
    expect(link).toEqual({
      id: LINK,
      status: "open",
      kind: "plan",
      summary: "The Pro plan, billed monthly.",
      item: { kind: "plan", plan: "pro", interval: "month" },
      teamId: null,
      url: OUR_URL,
      opened: false,
      createdAt: "2026-11-14T12:00:00.000Z",
      expiresAt: FUTURE,
      paidAt: null,
      expiredReason: null,
      bought: null,
      matches: null,
    });
  });

  it("bills a team's purchase to the team, on its owner's site", async () => {
    mocks.accountHomeOrigin.mockResolvedValue("https://mailhooks.cc");
    mocks.results.push({ data: row({ user_id: null, team_id: TEAM }), error: null });
    await createCheckoutLink(
      { userId: "owner-1" },
      { kind: "blocks", blocks: 2, resource: "requests", teamId: TEAM }
    );
    expect(mocks.oneTimeBlocksPurchase).toHaveBeenCalledWith(
      { kind: "team", teamId: TEAM },
      "owner-1",
      2,
      "requests"
    );
    expect(mocks.accountHomeOrigin).toHaveBeenCalledWith("owner-1");
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({
      p_user_id: null,
      p_team_id: TEAM,
      p_origin: "https://mailhooks.cc",
    });
  });

  it("keeps an overage link's maximum, and says it", async () => {
    mocks.results.push({
      data: row({ kind: "overage", item: { kind: "overage", resource: "requests", max: 250_000 } }),
      error: null,
    });
    const link = await createCheckoutLink(
      { userId: "user-1" },
      { kind: "overage", resource: "requests" }
    );
    expect(mocks.rpc.mock.calls[0][1].p_item).toEqual({
      kind: "overage",
      resource: "requests",
      max: 250_000,
    });
    expect(link.summary).toBe(
      "Overage for the account's requests, billed for what is used past the plan, up to 250,000 requests a month."
    );
  });

  it("refuses what cannot be bought, a team member included, before making a link", async () => {
    const notOwner = new TeamBillingError("not_owner", "Only the team owner can manage billing");
    mocks.teamPlanPurchase.mockRejectedValue(notOwner);
    await expect(
      createCheckoutLink(
        { userId: "member-1" },
        { kind: "team_plan", teamId: TEAM, seats: 3, plan: "team", interval: "month" }
      )
    ).rejects.toBe(notOwner);
    expect(mocks.rpc).not.toHaveBeenCalled();
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
  });
});

describe("getCheckoutLink", () => {
  it("reads only the asker's own links, never with a Polar url", async () => {
    mocks.results.push({
      data: row({
        status: "paid",
        paid_at: "2026-11-14T12:05:00Z",
        polar_checkout_id: "polar_checkout_1",
        expected: PRO,
        bought: { product: "prod_pro", seats: null, units: null, amount: 900, currency: "usd" },
      }),
      error: null,
    });
    const link = await getCheckoutLink(LINK, "user-1");
    expect(mocks.queries[0].filters).toEqual([["eq", "id", LINK]]);
    expect(link).toMatchObject({
      status: "paid",
      url: null,
      bought: { product: "prod_pro", amount: 900 },
      matches: true,
    });
    expect(JSON.stringify(link)).not.toContain("polar_checkout_1");

    // Anyone else's: not found.
    mocks.results.push({ data: row(), error: null });
    expect(await getCheckoutLink(LINK, "user-2")).toBeNull();
  });

  it("reads a team link for its asker and the team's owner now, while the asker owns the team", async () => {
    const teamRow = row({ user_id: null, team_id: TEAM, created_by: "owner-1" });
    // The asker, still the owner.
    mocks.results.push({ data: teamRow, error: null });
    expect(await getCheckoutLink(LINK, "owner-1")).toMatchObject({ id: LINK });
    expect(mocks.getTeamForOwner).toHaveBeenCalledWith("owner-1", TEAM);

    // Another owner of the team, while the asker still owns it too.
    mocks.results.push({ data: teamRow, error: null });
    expect(await getCheckoutLink(LINK, "owner-2")).toMatchObject({ id: LINK });
    expect(mocks.getTeamForOwner).toHaveBeenCalledWith("owner-2", TEAM);

    // A member who does not own the team.
    mocks.getTeamForOwner.mockImplementation(async (userId: string) => {
      if (userId === "owner-1") return { id: TEAM };
      throw new TeamBillingError("not_owner", "Only the team owner can manage billing");
    });
    mocks.results.push({ data: teamRow, error: null });
    expect(await getCheckoutLink(LINK, "member-1")).toBeNull();

    // The asker gave up the team: their keys lose the link, and so does everyone.
    mocks.getTeamForOwner.mockImplementation(async (userId: string) => {
      if (userId === "owner-2") return { id: TEAM };
      throw new TeamBillingError("not_owner", "Only the team owner can manage billing");
    });
    mocks.results.push({ data: teamRow, error: null });
    expect(await getCheckoutLink(LINK, "owner-1")).toBeNull();
    mocks.results.push({ data: teamRow, error: null });
    expect(await getCheckoutLink(LINK, "owner-2")).toBeNull();
  });

  it("reads matches false when the webhook found a top-up paid on another base", async () => {
    mocks.results.push({
      data: row({
        kind: "monthly_blocks",
        item: { kind: "monthly_blocks", blocks: 5, resource: "requests" },
        status: "paid",
        expected: { product: "prod_add", units: 2 },
        bought: { product: "prod_add", seats: null, units: 2, amount: 400, currency: "usd" },
        mismatch: "base",
      }),
      error: null,
    });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ matches: false });
  });

  it("expires a link never opened once its time is up, without asking Polar", async () => {
    mocks.results.push({ data: row({ expires_at: PAST }), error: null });
    mocks.results.push({ data: [row({ expires_at: PAST, status: "expired" })], error: null });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "expired", url: null });
    expect(mocks.checkoutsGet).not.toHaveBeenCalled();
  });

  it("settles an opened link past its expiry from Polar, at most every 30 seconds", async () => {
    const opened = { expires_at: PAST, polar_checkout_id: "polar_checkout_1", expected: PRO };
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null }); // the check's claim
    mocks.checkoutsGet.mockResolvedValue({
      status: "succeeded",
      product_id: "prod_pro",
      subscription_id: "sub_1",
    });
    mocks.subscriptionsGet.mockResolvedValue({ id: "sub_1", status: "active", ended_at: null });
    mocks.results.push({ data: [row({ ...opened, status: "paid" })], error: null });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "paid" });
    expect(mocks.queries[1].patch).toHaveProperty("polar_checked_at");
    // The stamp is a claim: only one read asks Polar at a time.
    expect(mocks.queries[1].filters).toContainEqual([
      "or",
      expect.stringMatching(/^polar_checked_at\.is\.null,polar_checked_at\.lt\./),
      null,
    ]);
    expect(mocks.checkoutsGet).toHaveBeenCalledWith("polar_checkout_1", { timeout: 5 });
    expect(mocks.queries[2].patch).toMatchObject({
      status: "paid",
      bought: { product: "prod_pro" },
    });

    // Asked 10 seconds ago: not again.
    mocks.checkoutsGet.mockClear();
    mocks.results.push({
      data: row({ ...opened, polar_checked_at: new Date(Date.now() - 10_000).toISOString() }),
      error: null,
    });
    // Still open, but past its expiry: never handed out again.
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open", url: null });
    expect(mocks.checkoutsGet).not.toHaveBeenCalled();

    // Polar unreachable just past its expiry: still open, and asked again later.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const justPast = { ...opened, expires_at: new Date(Date.now() - 60_000).toISOString() };
    mocks.results.push({ data: row(justPast), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    mocks.checkoutsGet.mockRejectedValue(new Error("down"));
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open" });
  });

  it("says when what was bought is not what the link asked for", () => {
    const bought = { product: "prod_teams", seats: 5, units: null, amount: 0, currency: "usd" };
    expect(boughtMatches({ product: "prod_teams", seats: 3 }, bought)).toBe(false);
    expect(boughtMatches({ product: "prod_teams", seats: 5 }, bought)).toBe(true);
    expect(boughtMatches({ product: "prod_business" }, bought)).toBe(false);
    expect(boughtMatches(null, bought)).toBeNull();
  });

  it("reads matches as not known yet while the seats or units it names are", () => {
    // An order handled before its subscription's event leaves the seats out.
    const fromOrder = {
      product: "prod_teams",
      seats: null,
      units: null,
      amount: 3600,
      currency: "usd",
    };
    expect(boughtMatches({ product: "prod_teams", seats: 3 }, fromOrder)).toBeNull();
    expect(
      boughtMatches({ product: "prod_add", units: 2 }, { ...fromOrder, product: "prod_add" })
    ).toBeNull();
    // A product that differs is known at once.
    expect(boughtMatches({ product: "prod_business", seats: 3 }, fromOrder)).toBe(false);
    // A link that names no count matches on the product alone.
    expect(boughtMatches({ product: "prod_teams" }, fromOrder)).toBe(true);
  });

  it("keeps what a paid link bought when its subscription changes later", () => {
    const paid = { product: "prod_teams", seats: 3, units: null, amount: 3600, currency: "usd" };
    // A week later: 5 seats, then Team Business. Polar keeps checkout_id on the subscription.
    const update = { source: "subscription", type: "subscription.updated" } as const;
    expect(mergeBought(paid, { ...paid, seats: 5, amount: 6000 }, update)).toEqual(paid);
    expect(mergeBought(paid, { ...paid, product: "prod_team_business" }, update)).toEqual(paid);
    // Only what is still unknown is filled in, and the order's amount wins.
    const fromOrder = { ...paid, seats: null, amount: 3600 };
    const created = { source: "subscription", type: "subscription.created" } as const;
    expect(mergeBought(fromOrder, { ...paid, amount: 9999 }, created)).toEqual(paid);
    expect(
      mergeBought(
        { ...paid, amount: null, currency: null },
        { ...paid, seats: null },
        { source: "order" }
      )
    ).toEqual(paid);
  });

  it("holds a link whose session Polar still has open for 15 minutes past expiry, then expires it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const opened = { expires_at: recent, polar_checkout_id: "polar_checkout_1", expected: PRO };
    for (const answer of [
      () => mocks.checkoutsGet.mockResolvedValue({ status: "open" }),
      () => mocks.checkoutsGet.mockRejectedValue(new Error("down")),
    ]) {
      mocks.queries.length = 0;
      answer();
      mocks.results.push({ data: row(opened), error: null });
      mocks.results.push({ data: [{ id: LINK }], error: null }); // the check's claim
      expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open", url: null });
      expect(mocks.queries.some((q) => q.patch?.status === "expired")).toBe(false);
    }

    // Past the grace: expired (a late payment still marks it paid).
    const old = { ...opened, expires_at: new Date(Date.now() - 16 * 60_000).toISOString() };
    for (const answer of [
      () => mocks.checkoutsGet.mockResolvedValue({ status: "open" }),
      () => mocks.checkoutsGet.mockRejectedValue(new Error("down")),
    ]) {
      mocks.queries.length = 0;
      answer();
      mocks.results.push({ data: row(old), error: null });
      mocks.results.push({ data: [{ id: LINK }], error: null });
      mocks.results.push({ data: [row({ ...old, status: "expired" })], error: null });
      expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "expired" });
    }

    // Confirming at Polar: held, whatever the time.
    mocks.queries.length = 0;
    mocks.checkoutsGet.mockResolvedValue({ status: "confirmed" });
    mocks.results.push({ data: row(old), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open" });
    expect(mocks.queries.some((q) => q.patch?.status === "expired")).toBe(false);

    // ...but not past a day: expired, and reported for someone to look at.
    mocks.queries.length = 0;
    const dayOld = { ...opened, expires_at: new Date(Date.now() - 25 * 3_600_000).toISOString() };
    mocks.results.push({ data: row(dayOld), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    mocks.results.push({ data: [row({ ...dayOld, status: "expired" })], error: null });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "expired" });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.stringContaining("stayed unsettled for a day"),
      undefined,
      { linkId: LINK }
    );
  });

  it("never expires a link while a session it replaced is still being paid", async () => {
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    const opened = {
      expires_at: old,
      polar_checkout_id: "polar_checkout_2",
      previous_checkout_ids: ["polar_checkout_1"],
      expected: PRO,
    };
    mocks.checkoutsGet.mockImplementation(async (id: string) =>
      id === "polar_checkout_2" ? { status: "expired" } : { status: "confirmed" }
    );
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open" });
    expect(mocks.checkoutsGet).toHaveBeenCalledWith("polar_checkout_1", { timeout: 5 });
    expect(mocks.queries.some((q) => q.patch?.status === "expired")).toBe(false);

    // The replaced session was paid: the link is paid through it.
    mocks.queries.length = 0;
    mocks.checkoutsGet.mockImplementation(async (id: string) =>
      id === "polar_checkout_2"
        ? { status: "expired" }
        : {
            id,
            status: "succeeded",
            product_id: "prod_pro",
            customer_id: "cus_1",
            subscription_id: "sub_1",
          }
    );
    mocks.subscriptionsGet.mockResolvedValue({ id: "sub_1", status: "active", ended_at: null });
    mocks.results.push({ data: row(opened), error: null }); // read
    mocks.results.push({ data: [{ id: LINK }], error: null }); // claim
    mocks.results.push({ data: [], error: null }); // no link follows polar_checkout_1
    mocks.results.push({
      data: [
        {
          id: LINK,
          polar_checkout_id: "polar_checkout_2",
          previous_checkout_ids: ["polar_checkout_1"],
        },
      ],
      error: null,
    }); // this one replaced it
    mocks.results.push({ data: [{ id: LINK }], error: null }); // paid through it
    mocks.results.push({ data: [], error: null }); // links it paid before
    mocks.results.push({
      data: row({
        ...opened,
        status: "paid",
        polar_checkout_id: "polar_checkout_1",
        paid_checkout_id: "polar_checkout_1",
        previous_checkout_ids: ["polar_checkout_2"],
        mismatch: "replaced",
        bought: { product: "prod_pro", seats: null, units: null, amount: null, currency: null },
      }),
      error: null,
    }); // read again
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "paid", matches: false });
    expect(mocks.queries.find((q) => q.patch?.mismatch === "replaced")?.patch).toMatchObject({
      polar_checkout_id: "polar_checkout_1",
      paid_checkout_id: "polar_checkout_1",
      previous_checkout_ids: ["polar_checkout_2"],
    });
  });
});

describe("openCheckoutLink", () => {
  it("checks again, makes the session for the link and sends the person to it", async () => {
    mocks.results.push({ data: row(), error: null }); // read
    mocks.results.push({ data: { id: LINK }, error: null }); // the opening lease
    mocks.results.push({ data: [{ id: LINK }], error: null }); // the session stored
    await expect(openCheckoutLink(LINK, "user-1")).resolves.toEqual({
      kind: "redirect",
      url: POLAR_URL,
      summary: "The Pro plan, billed monthly.",
      link: { kind: "plan", resource: null },
    });
    expect(mocks.planPurchase).toHaveBeenCalledWith("user-1", "pro", "month");
    expect(mocks.mint).toHaveBeenCalledWith({
      id: LINK,
      successUrl: "https://webhooks.cc/checkout/complete",
    });
    expect(mocks.queries[1]).toMatchObject({
      patch: { opening_at: expect.any(String) },
      filters: expect.arrayContaining([["eq", "status", "open"]]),
    });
    const lease = mocks.queries[1].patch?.opening_at;
    // The first lease stamps when the person opened it, for good.
    expect(mocks.queries[1].patch?.opened_at).toBe(lease);
    // No session was replaced.
    expect(mocks.queries[2].patch).not.toHaveProperty("previous_checkout_ids");
    expect(mocks.queries[2]).toMatchObject({
      op: "update",
      patch: {
        polar_checkout_id: "polar_checkout_1",
        expected: PRO,
        detached_at: null,
        opening_at: null,
        expires_at: FUTURE,
      },
      // Only while this tab still holds the lease it took.
      filters: expect.arrayContaining([["eq", "opening_at", lease]]),
    });
  });

  it("reuses the link's session while Polar has it open and the purchase is unchanged", async () => {
    const opened = { polar_checkout_id: "polar_checkout_1", expected: PRO };
    mocks.results.push({ data: row(opened), error: null });
    mocks.checkoutsGet.mockResolvedValue({
      status: "open",
      url: POLAR_URL,
      product_id: "prod_pro",
      expires_at: FUTURE,
    });
    await expect(openCheckoutLink(LINK, "user-1")).resolves.toMatchObject({
      kind: "redirect",
      url: POLAR_URL,
    });
    // Checked again even for a stored session.
    expect(mocks.planPurchase).toHaveBeenCalledWith("user-1", "pro", "month");
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("refuses a stored session the account can no longer buy", async () => {
    const opened = { polar_checkout_id: "polar_checkout_1", expected: PRO };
    mocks.results.push({ data: row(opened), error: null });
    mocks.checkoutsGet.mockResolvedValue({
      status: "open",
      url: POLAR_URL,
      product_id: "prod_pro",
      expires_at: FUTURE,
    });
    // A plan bought in another tab meanwhile.
    const refused = new Error("You already have a plan; change it instead");
    mocks.planPurchase.mockRejectedValueOnce(refused);
    await expect(openCheckoutLink(LINK, "user-1")).rejects.toBe(refused);
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("makes a new session when a monthly top-up's base moved since the stored one", async () => {
    const item = { kind: "monthly_blocks", blocks: 5, resource: "requests" };
    // Made when the account had 3 blocks: it adds 2.
    const opened = {
      kind: "monthly_blocks",
      item,
      polar_checkout_id: "polar_checkout_1",
      expected: { product: "prod_add", units: 2 },
    };
    mocks.results.push({ data: row(opened), error: null });
    mocks.checkoutsGet.mockResolvedValue({
      status: "open",
      url: POLAR_URL,
      product_id: "prod_add",
      units: 2,
      expires_at: FUTURE,
    });
    // Blocks were added in the dashboard: 4 now, so 1 to add.
    const freshMint = vi.fn().mockResolvedValue({ ...session, id: "polar_checkout_2" });
    mocks.monthlyBlocksPurchase.mockResolvedValueOnce({
      expected: { product: "prod_add", units: 1 },
      mint: freshMint,
    });
    // The lease reads the session the row holds, and one it replaced before.
    mocks.results.push({
      data: {
        id: LINK,
        polar_checkout_id: "polar_checkout_1",
        previous_checkout_ids: ["polar_checkout_0"],
      },
      error: null,
    });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    await expect(openCheckoutLink(LINK, "user-1")).resolves.toMatchObject({ kind: "redirect" });
    expect(freshMint).toHaveBeenCalledTimes(1);
    expect(mocks.queries.at(-2)?.filters).toContainEqual(["eq", "status", "open"]);
    expect(mocks.queries.at(-1)?.patch).toMatchObject({
      polar_checkout_id: "polar_checkout_2",
      // Polar cannot end the old session: kept, so its payment finds the link.
      previous_checkout_ids: ["polar_checkout_0", "polar_checkout_1"],
      expected: { product: "prod_add", units: 1 },
    });
  });

  it("makes a new session when the link's own one moved to another purchase", async () => {
    const opened = { polar_checkout_id: "polar_checkout_1", expected: PRO };
    mocks.results.push({ data: row(opened), error: null });
    mocks.checkoutsGet.mockResolvedValue({
      status: "open",
      url: POLAR_URL,
      product_id: "prod_business",
      expires_at: FUTURE,
    });
    mocks.results.push({ data: { id: LINK }, error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    await expect(openCheckoutLink(LINK, "user-1")).resolves.toMatchObject({ kind: "redirect" });
    expect(mocks.mint).toHaveBeenCalledTimes(1);
  });

  it("answers paid and processing from Polar's session, without a new one", async () => {
    const opened = { polar_checkout_id: "polar_checkout_1", expected: PRO };
    mocks.results.push({ data: row(opened), error: null });
    mocks.checkoutsGet.mockResolvedValue({ status: "confirmed" });
    expect((await openCheckoutLink(LINK, "user-1")).kind).toBe("processing");

    // Succeeded with no live subscription to show for it (a one-time
    // order, or one not live): processing, for the webhook to settle.
    mocks.results.push({ data: row(opened), error: null });
    mocks.checkoutsGet.mockResolvedValue({ status: "succeeded", product_id: "prod_pro" });
    expect((await openCheckoutLink(LINK, "user-1")).kind).toBe("processing");
    mocks.results.push({ data: row(opened), error: null });
    mocks.checkoutsGet.mockResolvedValue({
      status: "succeeded",
      product_id: "prod_pro",
      subscription_id: "sub_1",
    });
    mocks.subscriptionsGet.mockResolvedValue({
      id: "sub_1",
      status: "canceled",
      ended_at: "2026-11-15T00:00:00Z",
    });
    expect((await openCheckoutLink(LINK, "user-1")).kind).toBe("processing");
    expect(mocks.queries.some((q) => q.patch?.status === "paid")).toBe(false);

    mocks.subscriptionsGet.mockResolvedValue({ id: "sub_1", status: "active", ended_at: null });
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [row({ ...opened, status: "paid" })], error: null });
    expect((await openCheckoutLink(LINK, "user-1")).kind).toBe("paid");

    // The webhook marked it paid first: read again, and answered paid.
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [], error: null }); // markPaid finds nothing left to change
    mocks.results.push({ data: row({ ...opened, status: "paid" }), error: null });
    expect((await openCheckoutLink(LINK, "user-1")).kind).toBe("paid");
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.planPurchase).not.toHaveBeenCalled();
  });

  it("answers a paid, superseded or expired link as it stands", async () => {
    for (const status of ["paid", "superseded", "expired"]) {
      mocks.results.push({ data: row({ status }), error: null });
      expect((await openCheckoutLink(LINK, "user-1")).kind).toBe(status);
    }
    // One let go of while Polar never said it was unpaid says so.
    mocks.results.push({
      data: row({ status: "expired", expired_reason: "unsettled" }),
      error: null,
    });
    expect(await openCheckoutLink(LINK, "user-1")).toMatchObject({
      kind: "expired",
      expiredReason: "unsettled",
    });
    mocks.results.push({ data: row({ status: "expired" }), error: null });
    expect(await openCheckoutLink(LINK, "user-1")).toMatchObject({
      kind: "expired",
      expiredReason: null,
    });
    mocks.results.push({ data: row({ expires_at: PAST }), error: null });
    mocks.results.push({ data: [row({ status: "expired" })], error: null });
    expect((await openCheckoutLink(LINK, "user-1")).kind).toBe("expired");
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("answers processing, never expired, past expiry while Polar has not said", async () => {
    // Asked 10 seconds ago: the session may be being paid right now.
    const throttled = {
      expires_at: PAST,
      polar_checkout_id: "polar_checkout_1",
      expected: PRO,
      polar_checked_at: new Date(Date.now() - 10_000).toISOString(),
    };
    mocks.results.push({ data: row(throttled), error: null });
    expect((await openCheckoutLink(LINK, "user-1")).kind).toBe("processing");
    expect(mocks.checkoutsGet).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();

    // The review too, which says nothing about a charge.
    mocks.results.push({ data: row(throttled), error: null });
    mocks.results.push({ data: { email: "owner@example.com" }, error: null });
    mocks.results.push({ data: { name: "bot", key_prefix: "whcc_ab12" }, error: null });
    expect((await reviewCheckoutLink(LINK, "user-1", null)).status).toBe("processing");
    expect(mocks.planPurchase).not.toHaveBeenCalled();

    // A link never opened has nothing at Polar: expired.
    mocks.results.push({ data: row({ expires_at: PAST }), error: null });
    mocks.results.push({ data: [row({ status: "expired" })], error: null });
    expect((await openCheckoutLink(LINK, "user-1")).kind).toBe("expired");
  });

  it("refuses another account plainly", async () => {
    mocks.results.push({ data: row(), error: null });
    await expect(openCheckoutLink(LINK, "user-2")).rejects.toMatchObject({
      code: "wrong_account",
      status: 403,
    });

    // A team's link needs the team's owner now.
    mocks.assertCanManage.mockRejectedValue(new TeamBillingError("not_owner", "Not the owner"));
    mocks.results.push({ data: row({ user_id: null, team_id: TEAM }), error: null });
    await expect(openCheckoutLink(LINK, "member-1")).rejects.toMatchObject({
      code: "wrong_account",
    });
    expect(mocks.assertCanManage).toHaveBeenCalledWith({ kind: "team", teamId: TEAM }, "member-1");
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("answers 404 for a link that does not exist", async () => {
    mocks.results.push({ data: null, error: null });
    await expect(openCheckoutLink(LINK, "user-1")).rejects.toMatchObject({ status: 404 });
  });

  it("lets one tab make the session, and gives the lease back on failure", async () => {
    mocks.results.push({ data: row(), error: null });
    mocks.results.push({ data: null, error: null }); // the lease is held elsewhere
    mocks.results.push({
      data: row({ opening_at: new Date().toISOString() }),
      error: null,
    }); // read again: still open, being opened
    await expect(openCheckoutLink(LINK, "user-1")).rejects.toMatchObject({ code: "opening" });
    expect(mocks.mint).not.toHaveBeenCalled();
    // The claim is fenced on the session read: none yet.
    expect(mocks.queries[1].filters).toContainEqual(["is", "polar_checkout_id", null]);

    // Not taken because the link stopped being open: its real status, not "another tab".
    for (const [now, kind] of [
      [row({ status: "expired" }), "expired"], // cancelled meanwhile reads expired
      [row({ status: "paid" }), "paid"],
      [row({ expires_at: PAST }), "expired"],
    ] as const) {
      mocks.results.push({ data: row(), error: null });
      mocks.results.push({ data: null, error: null });
      mocks.results.push({ data: now, error: null });
      await expect(openCheckoutLink(LINK, "user-1")).resolves.toMatchObject({ kind });
    }
    expect(mocks.mint).not.toHaveBeenCalled();

    const refused = new Error("You already have a plan; change it instead");
    mocks.planPurchase.mockRejectedValueOnce(refused);
    mocks.results.push({ data: row(), error: null });
    // Refused before any lease is taken.
    await expect(openCheckoutLink(LINK, "user-1")).rejects.toBe(refused);
    expect(mocks.queries.at(-1)?.op).toBe("select");

    // The mint fails: only this tab's own lease is given back.
    mocks.mint.mockRejectedValueOnce(new Error("polar down"));
    mocks.results.push({ data: row(), error: null });
    mocks.results.push({ data: { id: LINK }, error: null });
    await expect(openCheckoutLink(LINK, "user-1")).rejects.toThrow("polar down");
    const lease = mocks.queries.at(-2)?.patch?.opening_at;
    expect(typeof lease).toBe("string");
    expect(mocks.queries.at(-1)).toMatchObject({
      patch: { opening_at: null },
      filters: [
        ["eq", "id", LINK],
        ["eq", "opening_at", lease],
      ],
    });
  });

  it("never hands out a session minted after its lease was taken over", async () => {
    mocks.results.push({ data: row(), error: null });
    mocks.results.push({ data: { id: LINK }, error: null });
    // Stalled past the lease: another tab holds it now, so the write matches nothing.
    mocks.results.push({ data: [], error: null });
    mocks.results.push({ data: row(), error: null }); // read again: still open
    await expect(openCheckoutLink(LINK, "user-1")).rejects.toMatchObject({ code: "opening" });
    expect(mocks.queries.at(-1)).toMatchObject({
      patch: { opening_at: null },
      filters: expect.arrayContaining([["eq", "opening_at", expect.any(String)]]),
    });
  });
});

describe("settleCheckoutLinkFromWebhook", () => {
  /** The queries that changed one row by id (not the session's own markPaid). */
  const updatesOf = (id: string) =>
    mocks.queries.filter(
      (q) => q.op === "update" && q.filters.some(([, c, v]) => c === "id" && v === id)
    );

  it("marks links paid by their session's order, with what it holds", async () => {
    await settleCheckoutLinkFromWebhook("order.paid", {
      id: "o1",
      checkout_id: "polar_checkout_1",
      product_id: "prod_pro",
      net_amount: 900,
      currency: "usd",
      metadata: { checkout_link: LINK },
    });
    expect(mocks.queries[0]).toMatchObject({
      op: "update",
      patch: {
        status: "paid",
        // The session that paid it.
        paid_checkout_id: "polar_checkout_1",
        bought: { product: "prod_pro", amount: 900, currency: "usd", seats: null, units: null },
      },
      filters: [
        ["eq", "polar_checkout_id", "polar_checkout_1"],
        ["in", "status", ["open", "expired"]],
      ],
    });
    // A link that replaced this session with a new one, or that follows it
    // but was superseded by another of its sessions: read first.
    expect(mocks.queries[1]).toMatchObject({
      op: "select",
      filters: [
        [
          "or",
          'and(previous_checkout_ids.cs.{polar_checkout_1},or(status.in.(open,expired),and(status.eq.superseded,paid_checkout_id.neq."polar_checkout_1"))),' +
            'and(polar_checkout_id.eq."polar_checkout_1",status.eq.superseded,paid_checkout_id.neq."polar_checkout_1")',
          null,
        ],
        ["is", "cancelled_at", null],
      ],
    });
    // The link the metadata names, in case it could not store the session:
    // read first, so only that case asks Polar anything.
    expect(mocks.queries[2]).toMatchObject({
      op: "select",
      filters: [
        ["eq", "id", LINK],
        ["in", "status", ["open", "expired"]],
        // Never a link let go of the session the metadata may still name it on.
        ["is", "detached_at", null],
        // Nor one its asker cancelled.
        ["is", "cancelled_at", null],
        ["is", "polar_checkout_id", null],
      ],
    });
    // Links this session already paid, and only those: one paid through
    // another of its sessions keeps that purchase.
    expect(mocks.queries[3]).toMatchObject({
      op: "select",
      filters: [
        ["eq", "status", "paid"],
        ["eq", "paid_checkout_id", "polar_checkout_1"],
      ],
    });
    expect(mocks.queries).toHaveLength(4);
  });

  it("takes an order's amount onto a paid link and keeps the seats its subscription had", async () => {
    const fromSubscription = {
      product: "prod_teams",
      seats: 3,
      units: null,
      amount: null,
      currency: null,
    };
    mocks.results.push({ data: [], error: null }); // already paid: markPaid changes nothing
    mocks.results.push({ data: [], error: null }); // no link replaced the session
    mocks.results.push({ data: [{ id: LINK, bought: fromSubscription }], error: null });
    // A team plan's order: Polar leaves its seats out.
    await settleCheckoutLinkFromWebhook("order.paid", {
      id: "o1",
      checkout_id: "polar_checkout_1",
      subscription_id: "sub_1",
      product_id: "prod_teams",
      seats: null,
      net_amount: 3600,
      currency: "usd",
    });
    const written = updatesOf(LINK);
    expect(written).toHaveLength(1);
    expect(written[0].patch).toEqual({
      bought: { product: "prod_teams", seats: 3, units: null, amount: 3600, currency: "usd" },
    });
    expect(written[0].filters).toContainEqual(["eq", "status", "paid"]);

    // Read back, it still matches what the link asked for.
    mocks.results.push({
      data: row({
        user_id: null,
        team_id: TEAM,
        created_by: "owner-1",
        kind: "team_plan",
        item: { kind: "team_plan", teamId: TEAM, seats: 3, plan: "team", interval: "month" },
        status: "paid",
        polar_checkout_id: "polar_checkout_1",
        expected: { product: "prod_teams", seats: 3 },
        bought: written[0].patch?.bought,
      }),
      error: null,
    });
    expect(await getCheckoutLink(LINK, "owner-1")).toMatchObject({
      matches: true,
      bought: { seats: 3, amount: 3600 },
    });

    // The order first, the subscription after: its seats fill in, the
    // order's amount stays.
    mocks.queries.length = 0;
    const fromOrder = {
      product: "prod_teams",
      seats: null,
      units: null,
      amount: 3600,
      currency: "usd",
    };
    mocks.results.push({ data: [], error: null });
    mocks.results.push({ data: [], error: null });
    mocks.results.push({ data: [{ id: LINK, bought: fromOrder }], error: null });
    await settleCheckoutLinkFromWebhook("subscription.created", {
      id: "sub_1",
      checkout_id: "polar_checkout_1",
      status: "active",
      product_id: "prod_teams",
      seats: 3,
      amount: 9999,
      currency: "usd",
    });
    expect(updatesOf(LINK)[0].patch).toEqual({
      bought: { product: "prod_teams", seats: 3, units: null, amount: 3600, currency: "usd" },
    });
  });

  it("pays a link that replaced the session with a new one, recording the mismatch", async () => {
    mocks.subscriptionsGet.mockResolvedValue({ id: "sub_1", status: "active", ended_at: null });
    mocks.results.push({ data: [], error: null }); // no link follows the session now
    mocks.results.push({
      data: [
        {
          id: LINK,
          polar_checkout_id: "polar_checkout_2",
          previous_checkout_ids: ["polar_checkout_0", "polar_checkout_1"],
        },
      ],
      error: null,
    }); // the link that replaced it
    mocks.results.push({ data: [{ id: LINK }], error: null }); // written
    await settleCheckoutLinkFromWebhook("subscription.created", {
      id: "sub_1",
      checkout_id: "polar_checkout_1",
      status: "active",
      product_id: "prod_add",
      units: 2,
    });
    expect(mocks.subscriptionsGet).toHaveBeenCalledWith("sub_1");
    expect(mocks.queries[2]).toMatchObject({
      op: "update",
      patch: {
        status: "paid",
        mismatch: "replaced",
        bought: { product: "prod_add", units: 2 },
        // It follows the session that paid from now on; the newer one is
        // kept as replaced, so its later payment is a duplicate of this one.
        polar_checkout_id: "polar_checkout_1",
        paid_checkout_id: "polar_checkout_1",
        previous_checkout_ids: ["polar_checkout_0", "polar_checkout_2"],
      },
      filters: [
        ["eq", "id", LINK],
        [
          "or",
          'status.in.(open,expired),and(status.eq.superseded,paid_checkout_id.neq."polar_checkout_1")',
          null,
        ],
        ["is", "cancelled_at", null],
        // Fenced on the session it followed when read.
        ["eq", "polar_checkout_id", "polar_checkout_2"],
      ],
    });

    // Its subscription already ended as a duplicate: never paid.
    mocks.queries.length = 0;
    mocks.subscriptionsGet.mockResolvedValue({
      id: "sub_1",
      status: "canceled",
      ended_at: "2026-11-15T00:00:00Z",
    });
    mocks.results.push({ data: [], error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    await settleCheckoutLinkFromWebhook("subscription.created", {
      id: "sub_1",
      checkout_id: "polar_checkout_1",
      status: "active",
    });
    expect(mocks.queries.some((q) => q.op === "update" && q.patch?.mismatch === "replaced")).toBe(
      false
    );
  });

  it("reads a link paid through a replaced session as paid, not matching", async () => {
    mocks.results.push({
      data: row({
        status: "paid",
        polar_checkout_id: "polar_checkout_2",
        previous_checkout_ids: ["polar_checkout_1"],
        expected: PRO,
        bought: { product: "prod_pro", seats: null, units: null, amount: 900, currency: "usd" },
        mismatch: "replaced",
      }),
      error: null,
    });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({
      status: "paid",
      matches: false,
    });
  });

  it("pays a link that never stored its session through the metadata", async () => {
    mocks.results.push({ data: [], error: null }); // no link follows the session
    mocks.results.push({ data: [], error: null }); // none replaced it
    mocks.results.push({ data: { id: LINK }, error: null }); // the named one waits
    pushCustomer();
    await settleCheckoutLinkFromWebhook("order.paid", {
      id: "o1",
      checkout_id: "polar_checkout_1",
      customer_id: "cus_1",
      product_id: "prod_pro",
      net_amount: 900,
      currency: "usd",
      metadata: { checkout_link: LINK },
    });
    // A one-time order has no subscription to end: Polar is not asked.
    expect(mocks.subscriptionsGet).not.toHaveBeenCalled();
    // The payment came from the link account's own Polar customer.
    expect(mocks.queries[4]).toMatchObject({
      table: "users",
      filters: [["eq", "id", "user-1"]],
    });
    // And no refund was recorded for the order (it bought something).
    expect(mocks.queries[5]).toMatchObject({
      table: "polar_refunds",
      filters: [["eq", "target", "order:o1"]],
    });
    expect(mocks.queries[6]).toMatchObject({
      op: "update",
      patch: {
        status: "paid",
        polar_checkout_id: "polar_checkout_1",
        paid_checkout_id: "polar_checkout_1",
      },
      filters: [
        ["eq", "id", LINK],
        ["in", "status", ["open", "expired"]],
        ["is", "detached_at", null],
        ["is", "cancelled_at", null],
        ["is", "polar_checkout_id", null],
      ],
    });
  });

  it("never pays a link through the metadata for a subscription the handlers just ended", async () => {
    // The plan handler ran first and revoked it as a second plan.
    mocks.subscriptionsGet.mockResolvedValue({
      id: "sub_2",
      status: "canceled",
      ended_at: "2026-11-15T00:00:00Z",
    });
    for (const [eventType, data] of [
      ["subscription.created", { id: "sub_2", status: "active" }],
      ["order.paid", { id: "o2", subscription_id: "sub_2" }],
    ] as const) {
      mocks.queries.length = 0;
      mocks.results.push({ data: [], error: null });
      mocks.results.push({ data: [], error: null });
      mocks.results.push({ data: { id: LINK }, error: null });
      pushCustomer();
      await settleCheckoutLinkFromWebhook(eventType, {
        ...data,
        checkout_id: "polar_checkout_2",
        customer_id: "cus_1",
        metadata: { checkout_link: LINK },
      });
      expect(mocks.subscriptionsGet).toHaveBeenLastCalledWith("sub_2");
      expect(updatesOf(LINK).some((q) => q.patch?.status === "paid")).toBe(false);
    }

    // Still live: paid as before.
    mocks.subscriptionsGet.mockResolvedValue({ id: "sub_2", status: "active", ended_at: null });
    mocks.queries.length = 0;
    mocks.results.push({ data: [], error: null });
    mocks.results.push({ data: [], error: null });
    mocks.results.push({ data: { id: LINK }, error: null });
    pushCustomer();
    await settleCheckoutLinkFromWebhook("subscription.created", {
      id: "sub_2",
      status: "active",
      checkout_id: "polar_checkout_2",
      customer_id: "cus_1",
      metadata: { checkout_link: LINK },
    });
    expect(mocks.queries[5]).toMatchObject({
      op: "update",
      patch: { status: "paid", polar_checkout_id: "polar_checkout_2" },
    });
  });

  it("never pays or supersedes a link through the metadata for another customer's payment", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.results.push({ data: [], error: null });
    mocks.results.push({ data: [], error: null });
    mocks.results.push({ data: { id: LINK }, error: null });
    pushCustomer("cus_1");
    await settleCheckoutLinkFromWebhook("order.paid", {
      id: "o3",
      checkout_id: "polar_checkout_9",
      customer_id: "cus_other",
      product_id: "prod_pro",
      metadata: { checkout_link: LINK },
    });
    expect(updatesOf(LINK)).toHaveLength(0);
  });

  it("marks a link paid by a live subscription, never a superseded one, and not when incomplete", async () => {
    await settleCheckoutLinkFromWebhook("subscription.created", {
      checkout_id: "polar_checkout_2",
      status: "active",
      seats: 3,
    });
    // The session's links, a link that replaced it, and those already paid.
    expect(mocks.queries).toHaveLength(3);
    // Superseded is not among the statuses paid moves from.
    expect(mocks.queries[0].filters).toContainEqual(["in", "status", ["open", "expired"]]);
    await settleCheckoutLinkFromWebhook("subscription.created", {
      checkout_id: "polar_checkout_3",
      status: "incomplete",
    });
    expect(mocks.queries).toHaveLength(3);
  });

  it("expires a link only while it is open and past its own expiry, and ignores everything else", async () => {
    await settleCheckoutLinkFromWebhook("checkout.updated", { id: "c1", status: "expired" });
    expect(mocks.queries[0]).toMatchObject({
      patch: { status: "expired" },
      filters: [
        ["eq", "polar_checkout_id", "c1"],
        ["eq", "status", "open"],
        // One that replaced sessions is left to a read, which asks about those too.
        ["filter", "previous_checkout_ids", "eq.{}"],
        ["lte", "expires_at", expect.any(String)],
      ],
    });
    await settleCheckoutLinkFromWebhook("checkout.updated", { id: "c1", status: "confirmed" });
    await settleCheckoutLinkFromWebhook("order.paid", { id: "o2", checkout_id: null });
    await settleCheckoutLinkFromWebhook("customer.updated", { id: "cus" });
    expect(mocks.queries).toHaveLength(1);
  });
});

describe("expireCheckoutLink", () => {
  it("expires a link nobody opened, fenced on nobody opening it meanwhile", async () => {
    mocks.results.push({ data: row(), error: null });
    mocks.results.push({ data: [row({ status: "expired" })], error: null });
    await expect(expireCheckoutLink(LINK, "user-1")).resolves.toMatchObject({
      status: "expired",
      url: null,
    });
    expect(mocks.queries[1]).toMatchObject({
      op: "update",
      // Stamped, so a session a tab was making meanwhile never pays it.
      patch: { status: "expired", cancelled_at: expect.any(String) },
      filters: expect.arrayContaining([
        ["eq", "status", "open"],
        ["is", "polar_checkout_id", null],
      ]),
    });
    expect(mocks.queries[1].filters.some(([kind]) => kind === "or")).toBe(true);
  });

  it("refuses an opened or paid link, one being opened, and anyone else's", async () => {
    mocks.results.push({ data: row({ polar_checkout_id: "polar_checkout_1" }), error: null });
    await expect(expireCheckoutLink(LINK, "user-1")).rejects.toMatchObject({
      code: "opened",
      status: 409,
    });
    mocks.results.push({ data: row({ status: "paid" }), error: null });
    await expect(expireCheckoutLink(LINK, "user-1")).rejects.toMatchObject({ code: "not_open" });
    mocks.results.push({ data: row(), error: null });
    mocks.results.push({ data: [], error: null });
    await expect(expireCheckoutLink(LINK, "user-1")).rejects.toMatchObject({ code: "opening" });
    mocks.results.push({ data: row(), error: null });
    await expect(expireCheckoutLink(LINK, "user-2")).rejects.toMatchObject({ status: 404 });
    // One already expired is answered as it is.
    mocks.results.push({ data: row({ status: "expired" }), error: null });
    await expect(expireCheckoutLink(LINK, "user-1")).resolves.toMatchObject({ status: "expired" });
  });
});

describe("reviewCheckoutLink", () => {
  it("says what it buys and costs, who asked and from where, and makes nothing", async () => {
    mocks.results.push({
      data: row({ network: "203.0.113.0/24", country: "DK" }),
      error: null,
    });
    mocks.results.push({ data: { email: "owner@example.com" }, error: null }); // users
    mocks.results.push({
      data: { name: "deploy\u202e bot", key_prefix: "whcc_ab12" },
      error: null,
    });
    const review = await reviewCheckoutLink(LINK, "user-1", "198.51.100.0/24");
    expect(review).toEqual({
      id: LINK,
      status: "open",
      kind: "plan",
      resource: null,
      summary: "The Pro plan, billed monthly.",
      price: "$8 a month",
      email: "owner@example.com",
      teamName: null,
      // The bidi override a key name could hide behind is gone, and the
      // name and prefix come apart from any sentence for the page to set.
      requester: { kind: "key", name: "deploy bot", prefix: "whcc_ab12" },
      // The purchase check passed.
      unavailable: null,
      unavailableCode: null,
      expiredReason: null,
      country: "DK",
      network: "different",
      createdAt: "2026-11-14T12:00:00.000Z",
      expiresAt: FUTURE,
    });
    // The purchase was checked (database reads only), and nothing made.
    expect(mocks.planPurchase).toHaveBeenCalledWith("user-1", "pro", "month");
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.checkoutsGet).not.toHaveBeenCalled();
    expect(mocks.queries.every((query) => query.op === "select")).toBe(true);
  });

  it("says up front why the account cannot buy it now", async () => {
    const { BillingActionError } = await import("@/lib/supabase/billing");
    mocks.results.push({ data: row({ requested_by_key: null }), error: null });
    mocks.results.push({ data: { email: "owner@example.com" }, error: null });
    mocks.planPurchase.mockRejectedValueOnce(
      new BillingActionError("already_pro", "You already have a plan; change it instead")
    );
    const review = await reviewCheckoutLink(LINK, "user-1", null);
    expect(review).toMatchObject({
      status: "open",
      unavailable: "You already have a plan; change it instead",
      requester: { kind: "session", name: null, prefix: null },
    });
    expect(mocks.mint).not.toHaveBeenCalled();

    // Anything else is not a refusal: it fails the read.
    mocks.results.push({ data: row({ requested_by_key: null }), error: null });
    mocks.results.push({ data: { email: "owner@example.com" }, error: null });
    mocks.planPurchase.mockRejectedValueOnce(new Error("database down"));
    await expect(reviewCheckoutLink(LINK, "user-1", null)).rejects.toThrow("database down");
  });

  it("names the team and the agent, and refuses anyone but the owner", async () => {
    mocks.results.push({
      data: row({
        user_id: null,
        team_id: TEAM,
        requested_by_key: "key-2",
        requested_by_agent: "agent-1",
        item: { kind: "team_plan", teamId: TEAM, seats: 3, plan: "team", interval: "month" },
        kind: "team_plan",
      }),
      error: null,
    });
    mocks.results.push({ data: { email: "owner@example.com" }, error: null });
    mocks.results.push({ data: { name: "Acme" }, error: null });
    mocks.results.push({ data: { client_name: "Claude Code" }, error: null });
    const review = await reviewCheckoutLink(LINK, "user-1", null);
    expect(review).toMatchObject({
      teamName: "Acme",
      requester: { kind: "agent", name: "Claude Code", prefix: null },
      price: "3 \u00d7 $12/seat/mo = $36/mo",
      network: "unknown",
    });

    mocks.results.push({ data: row(), error: null });
    await expect(reviewCheckoutLink(LINK, "user-2", null)).rejects.toMatchObject({
      code: "wrong_account",
    });
  });

  it("says a team link cannot open while another link's checkout is open, and until when", async () => {
    const message =
      "Another checkout link's checkout for this team is open until 12:30 UTC (2026-11-15T12:30:00.000Z), for another plan or seat count, and Polar cannot change it. Pay that one, or try again once it expires.";
    mocks.teamCheckoutBlocked.mockResolvedValueOnce({ code: "checkout_in_progress", message });
    mocks.results.push({
      data: row({
        user_id: null,
        team_id: TEAM,
        item: { kind: "team_plan", teamId: TEAM, seats: 3, plan: "team", interval: "month" },
        kind: "team_plan",
      }),
      error: null,
    });
    mocks.results.push({ data: { email: "owner@example.com" }, error: null });
    mocks.results.push({ data: { name: "Acme" }, error: null });
    const review = await reviewCheckoutLink(LINK, "user-1", null);
    expect(review).toMatchObject({
      status: "open",
      unavailable: message,
      unavailableCode: "checkout_in_progress",
    });
    // Asked with what this link's session would sell.
    expect(mocks.teamCheckoutBlocked).toHaveBeenCalledWith(TEAM, {
      product: "prod_teams",
      seats: 3,
    });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("says what a monthly top-up adds to what the account has", async () => {
    const item = { kind: "monthly_blocks", blocks: 5, resource: "requests" } as const;
    expect(checkoutSummary(item, 3)).toBe(
      "2 monthly blocks of 25,000 requests added to the 3 you have, renewing with the plan."
    );
    expect(checkoutSummary({ ...item, blocks: 4, teamId: TEAM }, 3)).toBe(
      "1 monthly block of 25,000 requests added to the 3 the team has, renewing with the plan."
    );
    expect(checkoutSummary(item)).toContain("5 monthly blocks of 25,000 requests in all");
    expect(checkoutPrice(item, 3)).toMatch(/ today for the 2 added, then .* a month in all$/);

    // The page reads the count the account has now from the purchase check.
    mocks.results.push({
      data: row({ kind: "monthly_blocks", item, requested_by_key: null }),
      error: null,
    });
    mocks.results.push({ data: { email: "owner@example.com" }, error: null });
    mocks.monthlyBlocksPurchase.mockResolvedValueOnce({ expected: PRO, have: 3, mint: mocks.mint });
    const review = await reviewCheckoutLink(LINK, "user-1", null);
    expect(review.summary).toBe(
      "2 monthly blocks of 25,000 requests added to the 3 you have, renewing with the plan."
    );
    expect(review.unavailable).toBeNull();
  });

  it("cleans names and prices every kind it can", () => {
    expect(cleanAskerName("a\u0000b\nc")).toBe("abc");
    // Quotes that could close the name early, straight or lookalike, go.
    expect(cleanAskerName('deploy" now, "pay')).toBe("deploy now, pay");
    expect(cleanAskerName("\u201Cdeploy\u201D \u00ABbot\u00BB")).toBe("deploy bot");
    expect(cleanAskerName("O'Brien's key")).toBe("O'Brien's key");
    expect(cleanAskerName("   ")).toBeNull();
    expect(cleanAskerName("x".repeat(100))).toHaveLength(60);
    expect(checkoutPrice({ kind: "plan", plan: "pro", interval: "year" })).toBeNull();
    expect(checkoutPrice({ kind: "blocks", blocks: 2, resource: "requests" })).toBe("$6.00 once");
    expect(checkoutPrice({ kind: "monthly_blocks", blocks: 3, resource: "domains" })).toContain(
      "$9.00 a month in all"
    );
    expect(checkoutPrice({ kind: "overage", resource: "requests" })).toContain("$4.00");
  });
});

describe("settling past expiry", () => {
  const recent = () => new Date(Date.now() - 5 * 60_000).toISOString();

  it("says whether the link was opened", async () => {
    const stamp = "2026-11-14T12:01:00.000Z";
    mocks.results.push({
      data: row({ polar_checkout_id: "polar_checkout_1", opened_at: stamp }),
      error: null,
    });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ opened: true });
    mocks.results.push({ data: row(), error: null });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ opened: false });
    // Opened, then let go of its session (a team's moved elsewhere, or a
    // tab that failed to make one): still opened, since a session that
    // names the link may exist.
    mocks.results.push({ data: row({ opened_at: stamp }), error: null });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ opened: true });
  });

  it("asks Polar only when this read wins the check's claim", async () => {
    const opened = { expires_at: recent(), polar_checkout_id: "polar_checkout_1", expected: PRO };
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [], error: null }); // another read claimed it
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open", url: null });
    expect(mocks.checkoutsGet).not.toHaveBeenCalled();
  });

  it("reads the sessions a few at once and gives up on them after its deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const opened = {
        expires_at: recent(),
        polar_checkout_id: "polar_checkout_3",
        previous_checkout_ids: ["polar_checkout_1", "polar_checkout_2"],
        expected: PRO,
      };
      // The link's own session never answers; the replaced ones are expired.
      mocks.checkoutsGet.mockImplementation((id: string) =>
        id === "polar_checkout_3" ? new Promise(() => {}) : Promise.resolve({ status: "expired" })
      );
      mocks.results.push({ data: row(opened), error: null });
      mocks.results.push({ data: [{ id: LINK }], error: null });
      const read = getCheckoutLink(LINK, "user-1");
      await vi.advanceTimersByTimeAsync(0);
      // All three asked at once, each with its own short timeout.
      expect(mocks.checkoutsGet).toHaveBeenCalledTimes(3);
      for (const call of mocks.checkoutsGet.mock.calls) expect(call[1]).toEqual({ timeout: 5 });
      await vi.advanceTimersByTimeAsync(15_001);
      // The one not read counts as unsettled: held, never failed or expired.
      expect(await read).toMatchObject({ status: "open", url: null });
      expect(mocks.queries.some((q) => q.patch?.status === "expired")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fails a read when a replaced session's payment cannot be applied", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const opened = {
      expires_at: recent(),
      polar_checkout_id: "polar_checkout_2",
      previous_checkout_ids: ["polar_checkout_1"],
      expected: PRO,
    };
    mocks.checkoutsGet.mockImplementation(async (id: string) =>
      id === "polar_checkout_2"
        ? { status: "expired" }
        : { id, status: "succeeded", product_id: "prod_pro", subscription_id: "sub_1" }
    );
    mocks.subscriptionsGet.mockResolvedValue({ id: "sub_1", status: "active", ended_at: null });
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    mocks.results.push({ data: null, error: new Error("connection reset") }); // settlePaid fails
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open" });
  });

  it("leaves a succeeded session without a live subscription to the webhook", async () => {
    const old = new Date(Date.now() - 16 * 60_000).toISOString();
    const opened = { expires_at: old, polar_checkout_id: "polar_checkout_1", expected: PRO };
    // A one-time order: no subscription to check.
    mocks.checkoutsGet.mockResolvedValue({ status: "succeeded", product_id: "prod_pro" });
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open" });
    // Neither paid nor expired, past the 15 minutes too: processing.
    expect(mocks.queries.some((q) => q.op === "update" && q.patch?.status)).toBe(false);
  });
});

describe("letting go of a link past its expiry", () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const expiredPatch = () => mocks.queries.find((q) => q.patch?.status === "expired")?.patch;

  it("marks one whose sessions Polar could not read unsettled, and alerts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const opened = { expires_at: ago(16), polar_checkout_id: "polar_checkout_1", expected: PRO };
    mocks.checkoutsGet.mockRejectedValue(new Error("polar down"));
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    mocks.results.push({
      data: [row({ ...opened, status: "expired", expired_reason: "unsettled" })],
      error: null,
    });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({
      status: "expired",
      expiredReason: "unsettled",
    });
    expect(expiredPatch()).toEqual({ status: "expired", expired_reason: "unsettled" });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.stringContaining("could not be read"),
      undefined,
      { linkId: LINK }
    );
  });

  it("marks one whose payment Polar was still confirming a day later unsettled", async () => {
    const opened = { expires_at: ago(24 * 60 + 1), polar_checkout_id: "polar_checkout_1" };
    mocks.checkoutsGet.mockResolvedValue({ status: "confirmed" });
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    mocks.results.push({
      data: [row({ ...opened, status: "expired", expired_reason: "unsettled" })],
      error: null,
    });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ expiredReason: "unsettled" });
    expect(expiredPatch()).toEqual({ status: "expired", expired_reason: "unsettled" });
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.stringContaining("for a day"),
      undefined,
      { linkId: LINK }
    );
  });

  it("expires one Polar says expired with no reason and no alert", async () => {
    const opened = { expires_at: ago(1), polar_checkout_id: "polar_checkout_1" };
    mocks.checkoutsGet.mockResolvedValue({ status: "expired" });
    mocks.results.push({ data: row(opened), error: null });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    mocks.results.push({ data: [row({ ...opened, status: "expired" })], error: null });
    expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({
      status: "expired",
      expiredReason: null,
    });
    expect(expiredPatch()).toEqual({ status: "expired" });
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("bounds the subscription reads and skips them past the deadline", async () => {
    try {
      const opened = {
        expires_at: ago(5),
        polar_checkout_id: "polar_checkout_2",
        previous_checkout_ids: ["polar_checkout_1"],
        expected: PRO,
      };
      mocks.checkoutsGet.mockImplementation(async (id: string) => ({
        id,
        status: "succeeded",
        product_id: "prod_pro",
        subscription_id: id === "polar_checkout_2" ? "sub_2" : "sub_1",
      }));
      // The first subscription read is not live, and takes the read past
      // its 15 seconds: the second is never asked.
      mocks.subscriptionsGet.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 20_000);
        return { id: "sub_2", status: "canceled", ended_at: ago(1) };
      });
      mocks.results.push({ data: row(opened), error: null });
      mocks.results.push({ data: [{ id: LINK }], error: null });
      expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open", url: null });
      expect(mocks.subscriptionsGet).toHaveBeenCalledTimes(1);
      expect(mocks.subscriptionsGet).toHaveBeenCalledWith("sub_2", { timeout: 5 });
      expect(mocks.queries.some((q) => q.op === "update" && q.patch?.status)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a replaced session's payment found past the reads' deadline", () => {
  it("is left for later instead of asking Polar again", async () => {
    try {
      const opened = {
        expires_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        polar_checkout_id: "polar_checkout_2",
        previous_checkout_ids: ["polar_checkout_1"],
        expected: PRO,
      };
      mocks.checkoutsGet.mockImplementation(async (id: string) =>
        id === "polar_checkout_2"
          ? { status: "expired" }
          : { id, status: "succeeded", product_id: "prod_pro", subscription_id: "sub_1" }
      );
      // Live, but the read takes the settle past its 15 seconds.
      mocks.subscriptionsGet.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 20_000);
        return { id: "sub_1", status: "active", ended_at: null };
      });
      mocks.results.push({ data: row(opened), error: null });
      mocks.results.push({ data: [{ id: LINK }], error: null });
      expect(await getCheckoutLink(LINK, "user-1")).toMatchObject({ status: "open", url: null });
      // settlePaid() never ran: Polar was asked once, and nothing was written.
      expect(mocks.subscriptionsGet).toHaveBeenCalledTimes(1);
      expect(mocks.queries.some((q) => q.op === "update" && q.patch?.status)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("opening a link another tab just opened", () => {
  it("reuses the session the other tab made instead of making another", async () => {
    mocks.results.push({ data: row(), error: null }); // read: no session yet
    mocks.results.push({ data: null, error: null }); // the claim misses: a session is there now
    const now = row({ polar_checkout_id: "polar_checkout_9", expected: PRO });
    mocks.results.push({ data: now, error: null }); // read again
    mocks.results.push({ data: now, error: null }); // and once more, opening again
    mocks.checkoutsGet.mockResolvedValue({
      status: "open",
      product_id: "prod_pro",
      url: "https://sandbox.polar.sh/checkout/polar_c_9",
      expires_at: FUTURE,
    });
    expect(await openCheckoutLink(LINK, "user-1")).toMatchObject({
      kind: "redirect",
      url: "https://sandbox.polar.sh/checkout/polar_c_9",
    });
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.checkoutsGet).toHaveBeenCalledWith("polar_checkout_9");
  });
});

describe("mergeBought", () => {
  const paid = { product: "prod_teams", seats: 3, units: null, amount: 3600, currency: "usd" };

  it("never takes the amount from a later order that is no purchase", () => {
    expect(
      mergeBought(
        paid,
        { ...paid, seats: 5, amount: 1200 },
        { source: "order", billingReason: "subscription_update" }
      )
    ).toEqual(paid);
    expect(
      mergeBought(paid, { ...paid, amount: 3700 }, { source: "order", billingReason: "purchase" })
    ).toEqual({ ...paid, amount: 3700 });
    // An order fills an amount nothing gave yet.
    expect(
      mergeBought(
        { ...paid, amount: null, currency: null },
        { ...paid, amount: 1200 },
        { source: "order", billingReason: "subscription_cycle" }
      )
    ).toEqual({ ...paid, amount: 1200 });
  });

  it("fills unknown counts only from the purchase's own events", () => {
    const fromOrder = { ...paid, seats: null };
    const now = Date.parse("2026-11-20T00:00:00.000Z");
    const weekAgo = "2026-11-13T00:00:00.000Z";
    // A seat change a week later is not what the link bought.
    expect(
      mergeBought(
        fromOrder,
        { ...paid, seats: 5 },
        { source: "subscription", type: "subscription.updated", paidAt: weekAgo },
        now
      )
    ).toEqual(fromOrder);
    // The subscription's created or active event, or anything soon after paying, is.
    expect(
      mergeBought(
        fromOrder,
        { ...paid, seats: 3 },
        { source: "subscription", type: "subscription.active", paidAt: weekAgo },
        now
      )
    ).toEqual(paid);
    expect(
      mergeBought(
        fromOrder,
        { ...paid, seats: 3 },
        {
          source: "subscription",
          type: "subscription.updated",
          paidAt: "2026-11-19T23:55:00.000Z",
        },
        now
      )
    ).toEqual(paid);
  });
});

describe("a link superseded through another of its sessions", () => {
  it("is paid by a replaced session whose purchase stands", async () => {
    mocks.subscriptionsGet.mockResolvedValue({ id: "sub_1", status: "active", ended_at: null });
    mocks.results.push({ data: [], error: null }); // no link follows the session
    mocks.results.push({
      data: [
        {
          id: LINK,
          polar_checkout_id: "polar_checkout_2",
          previous_checkout_ids: ["polar_checkout_1"],
        },
      ],
      error: null,
    });
    mocks.results.push({ data: [{ id: LINK }], error: null });
    await settleCheckoutLinkFromWebhook("subscription.created", {
      id: "sub_1",
      checkout_id: "polar_checkout_1",
      status: "active",
      product_id: "prod_pro",
    });
    const write = mocks.queries.find((q) => q.patch?.mismatch === "replaced");
    expect(write?.patch).toMatchObject({ status: "paid", paid_checkout_id: "polar_checkout_1" });
    // Open, expired, or superseded by a session other than this one.
    expect(write?.filters).toContainEqual([
      "or",
      'status.in.(open,expired),and(status.eq.superseded,paid_checkout_id.neq."polar_checkout_1")',
      null,
    ]);
  });

  it("is paid by its own session once another session's purchase was undone", async () => {
    mocks.subscriptionsGet.mockResolvedValue({ id: "sub_2", status: "active", ended_at: null });
    mocks.results.push({ data: [], error: null }); // none open or expired follows it
    mocks.results.push({
      data: [
        {
          id: LINK,
          polar_checkout_id: "polar_checkout_2",
          previous_checkout_ids: ["polar_checkout_1"],
        },
      ],
      error: null,
    }); // superseded by polar_checkout_1, following this one
    mocks.results.push({ data: [row({ status: "paid" })], error: null });
    await settleCheckoutLinkFromWebhook("subscription.created", {
      id: "sub_2",
      checkout_id: "polar_checkout_2",
      status: "active",
      product_id: "prod_pro",
    });
    expect(mocks.subscriptionsGet).toHaveBeenCalledWith("sub_2");
    const writes = mocks.queries.filter((q) => q.patch?.status === "paid");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      patch: { status: "paid", paid_checkout_id: "polar_checkout_2" },
      filters: [
        ["eq", "polar_checkout_id", "polar_checkout_2"],
        [
          "or",
          'status.in.(open,expired),and(status.eq.superseded,paid_checkout_id.neq."polar_checkout_2")',
          null,
        ],
        ["is", "cancelled_at", null],
      ],
    });
    // Never through a replaced session: it is the link's own.
    expect(mocks.queries.some((q) => q.patch?.mismatch === "replaced")).toBe(false);
  });

  it("is never paid by its own session when that purchase is not live either", async () => {
    mocks.subscriptionsGet.mockResolvedValue({
      id: "sub_2",
      status: "canceled",
      ended_at: "2026-11-15T00:00:00Z",
    });
    mocks.results.push({ data: [], error: null });
    mocks.results.push({
      data: [{ id: LINK, polar_checkout_id: "polar_checkout_2", previous_checkout_ids: [] }],
      error: null,
    });
    await settleCheckoutLinkFromWebhook("subscription.updated", {
      id: "sub_2",
      checkout_id: "polar_checkout_2",
      status: "active",
      product_id: "prod_pro",
    });
    expect(mocks.queries.filter((q) => q.patch?.status === "paid")).toHaveLength(1);
  });

  it("is never paid through a replaced session by a one-time order a refund was recorded for", async () => {
    mocks.results.push({ data: [], error: null }); // no link follows the session
    mocks.results.push({
      data: [
        {
          id: LINK,
          polar_checkout_id: "polar_checkout_2",
          previous_checkout_ids: ["polar_checkout_1"],
        },
      ],
      error: null,
    }); // this one replaced it
    mocks.results.push({ data: { id: "refund-1" }, error: null }); // the order bought nothing
    await settleCheckoutLinkFromWebhook("order.paid", {
      id: "o1",
      checkout_id: "polar_checkout_1",
      product_id: "prod_blocks",
      net_amount: 900,
      currency: "usd",
    });
    expect(mocks.queries[2]).toMatchObject({
      table: "polar_refunds",
      filters: [["eq", "target", "order:o1"]],
    });
    expect(mocks.queries.some((q) => q.patch?.mismatch === "replaced")).toBe(false);
    expect(mocks.subscriptionsGet).not.toHaveBeenCalled();
  });
});
