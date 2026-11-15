import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * trySpendFromBudget with its database, Polar and quote mocked: which reads
 * it makes, and how it answers when something fails before or after a take.
 */

const PERIOD_END = "2026-12-01T00:00:00.000Z";
const USER = "0b6a2a9e-3c1d-4e5f-8a7b-9c0d1e2f3a4b";

interface Db {
  user: Record<string, unknown> | null;
  userError: Error | null;
  /** An error the users read answers with (rather than throws), as PostgREST does. */
  userReadError: { message: string } | null;
  spendByKey: Record<string, unknown> | null;
  /** The row a status read finds; a function answers each read in turn. */
  spendRow: Record<string, unknown> | null | (() => Record<string, unknown> | null);
  registration: Record<string, unknown> | null;
  rpc: Record<string, (args: Record<string, unknown>) => unknown>;
  rpcCalls: { name: string; args: Record<string, unknown> }[];
}

const db: Db = {
  user: null,
  userError: null,
  userReadError: null,
  spendByKey: null,
  spendRow: null,
  registration: null,
  rpc: {},
  rpcCalls: [],
};

const polar: {
  subscription: { product_id: string; seats: number | null };
  get: (() => Promise<unknown>) | null;
} = {
  subscription: { product_id: "prod_pro_month", seats: null },
  get: null,
};

const mocks = vi.hoisted(() => ({
  loadBillingQuote: vi.fn(),
  makeBillingChange: vi.fn(),
  withBillingChangeLease: vi.fn(),
  reportError: vi.fn(),
}));

/** A query builder that answers what the table holds, awaited or with maybeSingle. */
function builder(table: string) {
  let columns = "";
  const answer = async () => {
    if (table === "users") {
      if (db.userError) throw db.userError;
      if (db.userReadError) return { data: null, error: db.userReadError };
      return { data: db.user, error: null };
    }
    if (table === "capacity_subscriptions") return { data: null, count: 0, error: null };
    if (table === "agent_registrations") return { data: db.registration, error: null };
    if (table === "agent_budget_spends") {
      return {
        data: columns.includes("outcome")
          ? db.spendByKey
          : typeof db.spendRow === "function"
            ? db.spendRow()
            : db.spendRow,
        error: null,
      };
    }
    return { data: null, error: null };
  };
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "neq", "gt", "order", "limit", "is", "in"]) {
    chain[method] = () => chain;
  }
  chain.select = (cols: string) => {
    columns = cols;
    return chain;
  };
  chain.maybeSingle = answer;
  chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
    answer().then(resolve, reject);
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ name, args });
      const handler = db.rpc[name];
      if (!handler) return { data: null, error: null };
      try {
        return { data: await handler(args), error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  }),
}));

vi.mock("@/lib/polar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/polar")>()),
  createPolarClient: () => ({
    subscriptions: { get: async () => (polar.get ? polar.get() : polar.subscription) },
  }),
  // Marks what passed through it, so a test sees no raw Polar error is reported.
  loggablePolarError: (error: unknown) => ({ loggable: error }),
  planProductId: (plan: string, interval: string) => `prod_${plan}_${interval}`,
  teamPlanProductId: (plan: string, interval: string) => `prod_${plan}_${interval}`,
}));

vi.mock("@/lib/audit", () => ({
  auditUserAction: vi.fn(async () => {}),
  auditSystemEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/email/mailer", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/observability", () => ({ reportError: mocks.reportError }));

vi.mock("./change", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./change")>();
  return {
    ...actual,
    loadBillingQuote: mocks.loadBillingQuote,
    makeBillingChange: mocks.makeBillingChange,
    withBillingChangeLease: mocks.withBillingChangeLease,
  };
});

const {
  emailSpend,
  keyLabel,
  LOST_TAKE_RECHECK_MS,
  settleAgentBudgetFromWebhook,
  trySpendFromBudget,
} = await import("./agent-budget");
const { BillingChangeRefusal, PAYMENT_ACTION_REQUIRED } = await import("./change");

const CHANGE = { kind: "plan", plan: "business", interval: "month" } as const;
const CALLER = { userId: USER, keyId: "5e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b" };

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/billing/plan", { method: "POST", headers });
}

function loadedQuote(currency = "usd") {
  return {
    teamName: null,
    at: (nowMs: number) => ({
      quotedAt: new Date(nowMs).toISOString(),
      change: "Change the plan from Pro (monthly) to Business (monthly).",
      applies: "now" as const,
      effectiveAt: new Date(nowMs).toISOString(),
      dueNowCents: 1000,
      approximate: false,
      renewalCents: 2900,
      renewsAt: PERIOD_END,
      notes: [],
      basis: { periodEnd: PERIOD_END },
    }),
    budget: () => ({
      creditAppliedCents: 0,
      renewalBeforeCents: 900,
      renewalAfterCents: 2900,
      annual: false,
      currency,
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T12:00:00.000Z"));
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  db.user = {
    agent_budget_cents: 10_000,
    plan: "pro",
    pending_plan: null,
    polar_subscription_id: "sub_1",
    subscription_status: "active",
    cancel_at_period_end: false,
    billing_interval: "month",
    home_site: null,
  };
  db.userError = null;
  db.userReadError = null;
  db.spendByKey = null;
  db.spendRow = null;
  db.registration = null;
  db.rpc = {};
  db.rpcCalls = [];
  polar.subscription = { product_id: "prod_pro_month", seats: null };
  polar.get = null;
  mocks.loadBillingQuote.mockReset().mockImplementation(async () => loadedQuote());
  mocks.makeBillingChange.mockReset();
  mocks.withBillingChangeLease
    .mockReset()
    .mockImplementation(async (_user, _team, fn) => fn({ mutations: 0 }));
  mocks.reportError.mockReset();
});

function settles() {
  return db.rpcCalls
    .filter((call) => call.name === "settle_agent_budget_spend")
    .map((call) => call.args.p_status);
}

describe("trySpendFromBudget", () => {
  it("quotes nothing when the budget is off, and still says why", async () => {
    db.user!.agent_budget_cents = 0;
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    expect(attempt).toMatchObject({ kind: "fallback", budget: { reason: "budget_off" } });
    expect(mocks.loadBillingQuote).not.toHaveBeenCalled();
    expect(mocks.withBillingChangeLease).not.toHaveBeenCalled();
  });

  it("leaves a change the budget never pays to the approval without a quote when it is off", async () => {
    db.user!.agent_budget_cents = 0;
    const attempt = await trySpendFromBudget(request(), CALLER, null, {
      kind: "plan",
      plan: "pro",
      interval: "month",
    });
    expect(attempt).toEqual({ kind: "none" });
    expect(mocks.loadBillingQuote).not.toHaveBeenCalled();
  });

  it("falls through to the approval when reading the account fails before a take", async () => {
    db.userError = new Error("connection reset");
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    expect(attempt).toEqual({ kind: "none" });
    expect(mocks.reportError).toHaveBeenCalled();
    expect(db.rpcCalls.some((call) => call.name === "take_agent_budget")).toBe(false);
  });

  it("answers outcome_unknown, not a plain failure, when recording a made change throws", async () => {
    db.rpc.take_agent_budget = () => ({ status: "taken", id: "spend-1", left: 5000 });
    let failed = false;
    db.rpc.settle_agent_budget_spend = (args) => {
      if (args.p_status === "applied" && !failed) {
        failed = true;
        throw new Error("statement timeout");
      }
      return args.p_status;
    };
    mocks.makeBillingChange.mockResolvedValue({ outcome: { executed: true, applied: "now" } });
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    expect(attempt.kind).toBe("done");
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "outcome_unknown", viaBudget: true });
    expect(settles()).toEqual(["applied", "unsettled"]);
  });

  it("counts a change at its charge plus the renewal rise and records that rise as counted", async () => {
    db.rpc.take_agent_budget = () => ({ status: "taken", id: "spend-1", left: 7000 });
    db.rpc.settle_agent_budget_spend = (args) => args.p_status;
    mocks.makeBillingChange.mockResolvedValue({ outcome: { executed: true, applied: "now" } });
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ countedCents: 3000, riseCounted: true, viaBudget: true });
    const take = db.rpcCalls.find((call) => call.name === "take_agent_budget")!;
    expect(take.args.p_cents).toBe(3000);
    expect(take.args.p_facts).toMatchObject({ riseCounted: true, renewalRiseCents: 2000 });
  });

  it("never gives back a resent spend whose first try may have charged", async () => {
    db.rpc.take_agent_budget = () => ({
      status: "existing",
      id: "spend-1",
      spend_status: "unsettled",
      outcome: null,
      age_seconds: 60,
      quoted_cents: 3000,
      amount_cents: 3000,
      period_end: PERIOD_END,
      budget: 10_000,
      others: 0,
    });
    db.rpc.claim_agent_budget_retry = () => ({ amount: 3000, resend: true });
    db.rpc.settle_agent_budget_spend = (args) => args.p_status;
    mocks.makeBillingChange.mockRejectedValue(
      new BillingChangeRefusal(409, "The card was declined", "card_declined")
    );
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "outcome_unknown" });
    expect(settles()).toEqual(["unsettled"]);
  });

  it("only looks at a resend the claim finds the budget no longer covers", async () => {
    db.rpc.take_agent_budget = () => ({
      status: "existing",
      id: "spend-1",
      spend_status: "unsettled",
      outcome: null,
      age_seconds: 60,
      quoted_cents: 3000,
      amount_cents: 3000,
      period_end: PERIOD_END,
      budget: 10_000,
      others: 0,
    });
    // The owner lowered the budget after the take was read: the claim,
    // under the account's lock, makes it a look.
    db.rpc.claim_agent_budget_retry = () => ({ amount: 3000, resend: false });
    db.rpc.settle_agent_budget_spend = (args) => args.p_status;
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "outcome_unknown" });
    expect(mocks.makeBillingChange).not.toHaveBeenCalled();
    expect(settles()).toEqual(["unsettled"]);
    const claim = db.rpcCalls.find((call) => call.name === "claim_agent_budget_retry")!;
    expect(claim.args.p_cents).toBe(3000);
  });

  it("says what is left from a fresh read when the claim finds the budget lowered", async () => {
    db.rpc.take_agent_budget = () => ({
      status: "existing",
      id: "spend-1",
      spend_status: "unsettled",
      outcome: null,
      age_seconds: 60,
      quoted_cents: 3000,
      amount_cents: 3000,
      period_end: PERIOD_END,
      budget: 10_000,
      others: 0,
    });
    // Lowered to $40 since the take: the take's $100 would say $70 left.
    db.rpc.claim_agent_budget_retry = () => ({ amount: 3000, resend: false });
    db.rpc.agent_budget_state = () => ({
      status: "ok",
      budget: 4000,
      spent: 3000,
      left: 1000,
      next_release: null,
      spends: [],
    });
    // A webhook made the change meanwhile: answered as made, with what is left.
    db.rpc.settle_agent_budget_spend = () => "applied";
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(200);
    expect((await response.json()).budget).toMatchObject({ leftCents: 1000 });
    expect(mocks.makeBillingChange).not.toHaveBeenCalled();
  });

  it("keeps the 3-D Secure mark when its settle fails, so a retry never sends it again", async () => {
    db.rpc.take_agent_budget = () => ({ status: "taken", id: "spend-1", left: 7000 });
    let failed = false;
    db.rpc.settle_agent_budget_spend = (args) => {
      if (!failed) {
        failed = true;
        throw new Error("connection reset");
      }
      return args.p_status;
    };
    const { TeamBillingError } = await import("@/lib/supabase/team-billing");
    mocks.makeBillingChange.mockRejectedValue(
      new TeamBillingError("payment_action_required", "Confirm the payment")
    );
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "outcome_unknown",
      reason: PAYMENT_ACTION_REQUIRED,
    });
    const recorded = db.rpcCalls.filter((call) => call.name === "settle_agent_budget_spend");
    expect(recorded.map((call) => call.args)).toEqual([
      { p_id: "spend-1", p_status: "unsettled", p_outcome: { code: "payment_action_required" } },
      { p_id: "spend-1", p_status: "unsettled", p_outcome: { code: "payment_action_required" } },
    ]);
  });

  it("reports a Polar read that failed only through loggablePolarError", async () => {
    const polarError = new Error("Polar said: customer someone@example.com");
    mocks.loadBillingQuote.mockRejectedValue(polarError);
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    expect(attempt).toEqual({ kind: "none" });
    expect(mocks.reportError).toHaveBeenCalledWith(
      "[agent-budget] reading the change failed; asking for approval",
      { loggable: polarError }
    );
    for (const call of mocks.reportError.mock.calls) expect(call[1]).not.toBe(polarError);
  });

  it("sends a spend on a subscription billed in another currency to the approval", async () => {
    mocks.loadBillingQuote.mockImplementation(async () => loadedQuote("eur"));
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    expect(attempt).toMatchObject({
      kind: "fallback",
      budget: { used: false, reason: "budget_currency_unsupported" },
    });
    expect(db.rpcCalls.some((call) => call.name === "take_agent_budget")).toBe(false);
  });

  it("keeps the currency out of the quote's basis, which an approval compares", async () => {
    const quote = loadedQuote().at(Date.now());
    expect(quote.basis).not.toHaveProperty("currency");
  });

  it("names a subscription with no currency apart, and reports it", async () => {
    mocks.loadBillingQuote.mockImplementation(async () => loadedQuote(""));
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    expect(attempt).toMatchObject({
      kind: "fallback",
      budget: { used: false, reason: "budget_currency_unknown" },
    });
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(db.rpcCalls.some((call) => call.name === "take_agent_budget")).toBe(false);
  });

  it("gives back a declined card's spend", async () => {
    // Polar refuses an invoice-proration update with a declined card and
    // leaves the subscription as it was (PaymentFailed, 402).
    db.rpc.take_agent_budget = () => ({ status: "taken", id: "spend-1", left: 7000 });
    db.rpc.settle_agent_budget_spend = (args) => args.p_status;
    const { TeamBillingError } = await import("@/lib/supabase/team-billing");
    const { auditUserAction } = await import("@/lib/audit");
    const { sendEmail } = await import("@/lib/email/mailer");
    vi.mocked(auditUserAction).mockClear();
    vi.mocked(sendEmail).mockClear();
    mocks.makeBillingChange.mockRejectedValue(
      new TeamBillingError("payment_failed", "The card was declined")
    );
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "payment_failed" });
    const settle = db.rpcCalls.find((call) => call.name === "settle_agent_budget_spend")!;
    // The row keeps why: a charge Polar collects later brings it back.
    expect(settle.args).toMatchObject({
      p_status: "returned",
      p_outcome: { code: "payment_failed" },
    });
    expect(vi.mocked(auditUserAction).mock.calls.map((call) => call[2].action)).toContain(
      "billing.agent_budget_returned"
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("asks the owner for a reduction while a spend's outcome is not known", async () => {
    const blocks = { kind: "capacity", capacity: { action: "set_monthly_blocks", blocks: 1 } };
    mocks.loadBillingQuote.mockImplementation(async () => ({
      teamName: null,
      at: (nowMs: number) => ({
        ...loadedQuote().at(nowMs),
        change: "Renew 1 monthly block instead of 2.",
        applies: "renewal" as const,
        dueNowCents: 0,
        basis: {
          periodEnd: PERIOD_END,
          blocks: { units: 2, pendingUnits: null, cancelAtPeriodEnd: false },
        },
      }),
    }));
    db.rpc.agent_budget_decrease_check = () => "busy";
    const attempt = await trySpendFromBudget(request(), CALLER, null, blocks as never);
    expect(attempt).toMatchObject({ kind: "fallback", budget: { reason: "change_running" } });
    expect(mocks.makeBillingChange).not.toHaveBeenCalled();
    const check = db.rpcCalls.find((call) => call.name === "agent_budget_decrease_check")!;
    expect(check.args).toMatchObject({ p_user_id: USER, p_team_id: null, p_seats: null });
  });

  it("reads the currency from the quote, with no Polar read of its own", async () => {
    const get = vi.fn(async () => polar.subscription);
    polar.get = get;
    db.rpc.take_agent_budget = () => ({ status: "over", left: 0, needed: 3000 });
    await trySpendFromBudget(request(), CALLER, null, CHANGE);
    expect(get).not.toHaveBeenCalled();
  });

  it("makes a decrease whatever the currency, since it counts nothing", async () => {
    const blocks = { kind: "capacity", capacity: { action: "set_monthly_blocks", blocks: 1 } };
    mocks.loadBillingQuote.mockImplementation(async () => ({
      teamName: null,
      at: (nowMs: number) => ({
        ...loadedQuote("eur").at(nowMs),
        change: "Renew 1 monthly block instead of 2.",
        applies: "renewal" as const,
        dueNowCents: 0,
        basis: {
          periodEnd: PERIOD_END,
          blocks: { units: 2, pendingUnits: null, cancelAtPeriodEnd: false },
        },
      }),
    }));
    db.rpc.agent_budget_state = () => ({ status: "ok", budget: 10_000, spent: 0, left: 10_000 });
    mocks.makeBillingChange.mockResolvedValue({ outcome: { executed: true, applied: "renewal" } });
    const attempt = await trySpendFromBudget(request(), CALLER, null, blocks as never);
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ viaBudget: true, chargedCents: 0 });
  });

  it("gives back a take whose answer was lost before asking for approval", async () => {
    db.rpc.take_agent_budget = () => {
      throw new Error("statement timeout");
    };
    db.rpc.settle_agent_budget_spend = (args) => args.p_status;
    db.spendRow = { status: "running" };
    const attempt = await trySpendFromBudget(request(), CALLER, null, CHANGE);
    expect(attempt).toEqual({ kind: "none" });
    const take = db.rpcCalls.find((call) => call.name === "take_agent_budget")!;
    const settle = db.rpcCalls.find((call) => call.name === "settle_agent_budget_spend")!;
    expect(typeof take.args.p_id).toBe("string");
    expect(settle.args).toMatchObject({ p_id: take.args.p_id, p_status: "returned" });
    expect(mocks.makeBillingChange).not.toHaveBeenCalled();
  });

  it("marks a lost take's id when it made no spend after two looks, so a late take takes nothing", async () => {
    db.rpc.take_agent_budget = () => {
      throw new Error("statement timeout");
    };
    let reads = 0;
    db.spendRow = () => {
      reads++;
      return null;
    };
    const pending = trySpendFromBudget(request(), CALLER, null, CHANGE);
    await vi.advanceTimersByTimeAsync(LOST_TAKE_RECHECK_MS);
    expect(await pending).toEqual({ kind: "none" });
    expect(reads).toBe(2);
    const take = db.rpcCalls.find((call) => call.name === "take_agent_budget")!;
    const bury = db.rpcCalls.find((call) => call.name === "bury_lost_agent_budget_take")!;
    expect(bury.args).toEqual({ p_id: take.args.p_id, p_user_id: USER, p_team_id: null });
    expect(settles()).toEqual([]);
  });

  it("gives back a take that landed between the second look and the mark", async () => {
    db.rpc.take_agent_budget = () => {
      throw new Error("statement timeout");
    };
    db.rpc.settle_agent_budget_spend = (args) => args.p_status;
    db.rpc.bury_lost_agent_budget_take = () => "running";
    db.spendRow = null;
    const pending = trySpendFromBudget(request(), CALLER, null, CHANGE);
    await vi.advanceTimersByTimeAsync(LOST_TAKE_RECHECK_MS);
    expect(await pending).toEqual({ kind: "none" });
    expect(settles()).toEqual(["returned"]);
  });

  it("finds a lost take that was still waiting on the row lock, on the second look", async () => {
    db.rpc.take_agent_budget = () => {
      throw new Error("statement timeout");
    };
    db.rpc.settle_agent_budget_spend = (args) => args.p_status;
    const answers = [null, { status: "running" }];
    db.spendRow = () => answers.shift() ?? null;
    const pending = trySpendFromBudget(request(), CALLER, null, CHANGE);
    await vi.advanceTimersByTimeAsync(LOST_TAKE_RECHECK_MS);
    expect(await pending).toEqual({ kind: "none" });
    expect(settles()).toEqual(["returned"]);
  });

  it("answers the same Idempotency-Key again from its spend before quoting, when a webhook made it", async () => {
    db.spendByKey = { id: "spend-1", status: "applied", change: CHANGE, outcome: null };
    db.spendRow = {
      id: "spend-1",
      description: "Change the plan from Pro (monthly) to Business (monthly).",
      amount_cents: 3000,
      facts: { chargeCents: 1000, renewalCents: 2900, renewalRiseCents: 2000, riseCounted: true },
    };
    const attempt = await trySpendFromBudget(
      request({ "idempotency-key": "retry-key-0001" }),
      CALLER,
      null,
      CHANGE
    );
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      replayed: true,
      executed: true,
      countedCents: 3000,
      chargedCents: 1000,
      idempotencyKey: "retry-key-0001",
    });
    expect(mocks.loadBillingQuote).not.toHaveBeenCalled();
  });

  it("refuses an Idempotency-Key that took a spend for another change", async () => {
    db.spendByKey = {
      id: "spend-1",
      status: "applied",
      change: { kind: "plan", plan: "business", interval: "year" },
      outcome: null,
    };
    const attempt = await trySpendFromBudget(
      request({ "idempotency-key": "retry-key-0001" }),
      CALLER,
      null,
      CHANGE
    );
    const response = (attempt as { response: Response }).response;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "idempotency_key_reused" });
  });
});

describe("settleAgentBudgetFromWebhook", () => {
  const paid = {
    id: "ord_1",
    status: "paid",
    billing_reason: "subscription_update",
    subscription_id: "sub_1",
    net_amount: 1000,
    created_at: "2026-11-15T11:59:00.000Z",
    product_id: "prod_business_month",
  };

  it("throws when a paid order cannot be counted, so Polar delivers it again", async () => {
    db.rpc.raise_agent_budget_from_order = () => {
      throw new Error("connection reset");
    };
    await expect(settleAgentBudgetFromWebhook("order.paid", paid)).rejects.toThrow(
      "connection reset"
    );
  });

  it("never throws for a subscription event, which the next one settles", async () => {
    db.rpc.settle_agent_budget_from_subscription = () => {
      throw new Error("connection reset");
    };
    await expect(
      settleAgentBudgetFromWebhook("subscription.updated", { id: "sub_1", seats: 5 })
    ).resolves.toBeUndefined();
    expect(mocks.reportError).toHaveBeenCalled();
  });

  it("does nothing for an order that is not a paid subscription change", async () => {
    await settleAgentBudgetFromWebhook("order.created", paid);
    await settleAgentBudgetFromWebhook("order.paid", { ...paid, billing_reason: "purchase" });
    expect(db.rpcCalls).toEqual([]);
  });
});

describe("emailSpend", () => {
  it("tries a spend email again when its owner could not be read, never dropping it", async () => {
    db.rpc.claim_agent_budget_email = () => true;
    db.rpc.finish_agent_budget_email = () => null;
    db.spendRow = {
      user_id: USER,
      team_id: null,
      key_id: null,
      agent_registration_id: null,
      description: "Change the plan.",
      amount_cents: 3000,
      facts: {},
    };
    db.userReadError = { message: "connection reset" };
    await expect(emailSpend("spend-1", "spent")).rejects.toMatchObject({
      message: "connection reset",
    });
    const finish = db.rpcCalls.find((call) => call.name === "finish_agent_budget_email")!;
    expect(finish.args).toMatchObject({ p_id: "spend-1", p_result: "failed" });
  });

  it("takes a spend email out of the queue only when the owner has no address", async () => {
    db.rpc.claim_agent_budget_email = () => true;
    db.rpc.finish_agent_budget_email = () => null;
    db.spendRow = {
      user_id: USER,
      team_id: null,
      key_id: null,
      agent_registration_id: null,
      description: "Change the plan.",
      amount_cents: 3000,
      facts: {},
    };
    db.user = null;
    expect(await emailSpend("spend-2", "spent")).toBe(false);
    const finish = db.rpcCalls.find((call) => call.name === "finish_agent_budget_email")!;
    expect(finish.args).toMatchObject({ p_id: "spend-2", p_result: "undeliverable" });
  });
});

describe("keyLabel", () => {
  it("names the agent from its registration once its token row is gone", async () => {
    db.registration = { client_name: 'Claude "Code"' };
    expect(await keyLabel("2f6c1a0e-0000-4000-8000-000000000001", "reg-1")).toBe(
      'the agent "Claude Code"'
    );
    db.registration = null;
    expect(await keyLabel("2f6c1a0e-0000-4000-8000-000000000001", "reg-1")).toBe("an agent");
    expect(await keyLabel("2f6c1a0e-0000-4000-8000-000000000001")).toBe("an API key");
  });
});
