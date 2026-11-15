import { beforeEach, describe, expect, it, vi } from "vitest";

interface Query {
  table: string;
  op: string | null;
  patch?: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
}

const mocks = vi.hoisted(() => ({
  queries: [] as Query[],
  results: [] as Array<{ data: unknown; error: unknown }>,
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
    contains: filter("contains"),
    or: (expression: string) => {
      query.filters.push(["or", expression, null]);
      return chain;
    },
    maybeSingle: settle,
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      settle().then(resolve, reject),
  });
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (table: string) => builder(table) }),
}));
vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }));

import { linkCustomerMatches, supersedeCheckoutLinks } from "./checkout-link-rows";

const LINK = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  mocks.results.length = 0;
});

describe("supersedeCheckoutLinks", () => {
  it("records the session that superseded each link", async () => {
    await supersedeCheckoutLinks("polar_checkout_1", null, null);
    const updates = mocks.queries.filter((q) => q.patch?.status === "superseded");
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.patch).toMatchObject({ paid_checkout_id: "polar_checkout_1" });
    }
  });

  it("asks about the customer only for a link that is a candidate", async () => {
    mocks.results.push({ data: null, error: null }); // the session's own links
    mocks.results.push({ data: null, error: null }); // paid_at stamp
    mocks.results.push({ data: null, error: null }); // links that replaced it
    mocks.results.push({ data: null, error: null }); // the named link is no candidate
    await supersedeCheckoutLinks("polar_checkout_1", { checkout_link: LINK }, "cus_other");
    // Nothing read from users or teams, nothing reported.
    expect(mocks.queries.some((q) => q.table !== "billing_checkouts")).toBe(false);
    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(mocks.queries.at(-1)).toMatchObject({ op: "select" });

    // A candidate paid from another customer: reported, never superseded.
    mocks.queries.length = 0;
    mocks.results.push({ data: null, error: null });
    mocks.results.push({ data: null, error: null });
    mocks.results.push({ data: null, error: null });
    mocks.results.push({ data: { id: LINK }, error: null });
    mocks.results.push({ data: { user_id: "user-1", team_id: null }, error: null });
    mocks.results.push({ data: { polar_customer_id: "cus_1" }, error: null });
    await supersedeCheckoutLinks("polar_checkout_1", { checkout_link: LINK }, "cus_other");
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.stringContaining("of another customer"),
      undefined,
      { linkId: LINK }
    );
    expect(
      mocks.queries.some(
        (q) => q.op === "update" && q.filters.some(([, c, v]) => c === "id" && v === LINK)
      )
    ).toBe(false);
  });
});

describe("linkCustomerMatches", () => {
  it("words a missing customer apart from another customer's", async () => {
    mocks.results.push({ data: { user_id: "user-1", team_id: null }, error: null });
    mocks.results.push({ data: { polar_customer_id: "cus_1" }, error: null });
    expect(await linkCustomerMatches(LINK, null)).toBe(false);
    expect(mocks.reportError).toHaveBeenLastCalledWith(
      expect.stringContaining("carries no customer"),
      undefined,
      { linkId: LINK }
    );

    mocks.results.push({ data: { user_id: "user-1", team_id: null }, error: null });
    mocks.results.push({ data: { polar_customer_id: null }, error: null });
    expect(await linkCustomerMatches(LINK, "cus_1")).toBe(false);
    expect(mocks.reportError).toHaveBeenLastCalledWith(
      expect.stringContaining("has no Polar customer yet"),
      undefined,
      { linkId: LINK }
    );

    mocks.results.push({ data: { user_id: "user-1", team_id: null }, error: null });
    mocks.results.push({ data: { polar_customer_id: "cus_1" }, error: null });
    mocks.reportError.mockClear();
    expect(await linkCustomerMatches(LINK, "cus_1")).toBe(true);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});
