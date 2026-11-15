import { PolarNetworkError } from "@polar-sh/sdk";
import { errors } from "@polar-sh/sdk/2026-10";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import {
  budgetCostCents,
  budgetStop,
  classifyChange,
  idempotencyKeyFor,
  keyLabelOf,
  mayBeForBudget,
  orderSeats,
  parseBudgetCents,
  renewalRiseCents,
  replayBodyOf,
  RESEND_MAX_AGE_SECONDS,
  RISE_COUNTED_DAYS,
  riseCounted,
  resendRefusal,
  spendErrorKind,
  spendTarget,
  usableIdempotencyHeader,
  type BudgetAccountState,
} from "./agent-budget";
import {
  BillingChangeRefusal,
  BillingChangeRetry,
  chargeCeiling,
  type BillingQuote,
} from "./change";
import { TeamBillingError } from "@/lib/supabase/team-billing";
import { BillingActionError } from "@/lib/supabase/billing";

function quote(overrides: Partial<BillingQuote> = {}): BillingQuote {
  return {
    quotedAt: "2026-11-14T12:00:00.000Z",
    change: "A change.",
    applies: "now",
    effectiveAt: "2026-11-14T12:00:00.000Z",
    dueNowCents: 1200,
    approximate: false,
    renewalCents: 3600,
    notes: [],
    basis: {},
    ...overrides,
  };
}

const TEAM = "6a3f0c8e-1d2b-4c5a-9e7f-0a1b2c3d4e5f";

describe("classifyChange", () => {
  it("spends on Pro to Business monthly, charged at once", () => {
    expect(
      classifyChange(null, { kind: "plan", plan: "business", interval: "month" }, quote())
    ).toBe("spend");
  });

  it("keeps any move to annual, and any plan change at the renewal, for the owner", () => {
    expect(
      classifyChange(null, { kind: "plan", plan: "business", interval: "year" }, quote())
    ).toBe("approval");
    expect(
      classifyChange(
        null,
        { kind: "plan", plan: "pro", interval: "month" },
        quote({ applies: "renewal" })
      )
    ).toBe("approval");
    expect(
      classifyChange(TEAM, { kind: "plan", plan: "team_business", interval: "year" }, quote())
    ).toBe("approval");
    expect(classifyChange(TEAM, { kind: "plan", plan: "team", interval: "month" }, quote())).toBe(
      "approval"
    );
  });

  it("spends on Teams to Team Business monthly", () => {
    expect(
      classifyChange(TEAM, { kind: "plan", plan: "team_business", interval: "month" }, quote())
    ).toBe("spend");
    // A downgrade from Team Business annual to monthly applies at the renewal.
    expect(
      classifyChange(
        TEAM,
        { kind: "plan", plan: "team_business", interval: "month" },
        quote({ applies: "renewal" })
      )
    ).toBe("approval");
  });

  it("spends on more seats and runs fewer seats as a decrease", () => {
    const basis = { teamSeats: 3, teamPendingSeats: null };
    expect(classifyChange(TEAM, { kind: "seats", seats: 5 }, quote({ basis }))).toBe("spend");
    expect(
      classifyChange(TEAM, { kind: "seats", seats: 2 }, quote({ basis, applies: "renewal" }))
    ).toBe("decrease");
    // Dropping a scheduled reduction raises the renewal: the owner's.
    expect(
      classifyChange(
        TEAM,
        { kind: "seats", seats: 3 },
        quote({ basis: { teamSeats: 3, teamPendingSeats: 2 } })
      )
    ).toBe("approval");
    // Between a scheduled reduction and today's seats: also a raise of the renewal.
    expect(
      classifyChange(
        TEAM,
        { kind: "seats", seats: 4 },
        quote({ basis: { teamSeats: 5, teamPendingSeats: 2 }, applies: "renewal" })
      )
    ).toBe("approval");
    expect(
      classifyChange(
        TEAM,
        { kind: "seats", seats: 1 },
        quote({ basis: { teamSeats: 5, teamPendingSeats: 2 }, applies: "renewal" })
      )
    ).toBe("decrease");
  });

  it("counts a reduction from the lower of our scheduled seats and Polar's", () => {
    // Polar already renews at 2 while our row still says 4 (its webhook is
    // late): 3 raises Polar's renewal, so it is not a decrease.
    const lagging = { teamSeats: 5, teamPendingSeats: 4, pendingSeats: 2 };
    expect(
      classifyChange(
        TEAM,
        { kind: "seats", seats: 3 },
        quote({ basis: lagging, applies: "renewal" })
      )
    ).toBe("approval");
    // And the other way round: our row is lower than Polar's.
    expect(
      classifyChange(
        TEAM,
        { kind: "seats", seats: 3 },
        quote({
          basis: { teamSeats: 5, teamPendingSeats: 2, pendingSeats: 4 },
          applies: "renewal",
        })
      )
    ).toBe("approval");
    expect(
      classifyChange(
        TEAM,
        { kind: "seats", seats: 1 },
        quote({ basis: lagging, applies: "renewal" })
      )
    ).toBe("decrease");
    // Polar's alone counts when our row has none.
    expect(
      classifyChange(
        TEAM,
        { kind: "seats", seats: 3 },
        quote({
          basis: { teamSeats: 5, teamPendingSeats: null, pendingSeats: 2 },
          applies: "renewal",
        })
      )
    ).toBe("approval");
  });

  it("keeps fewer seats for the owner while a plan change waits for the renewal", () => {
    const basis = { teamSeats: 3, teamPendingSeats: null };
    const fewer = { kind: "seats", seats: 2 } as const;
    const atRenewal = { basis, applies: "renewal" as const };
    expect(classifyChange(TEAM, fewer, quote(atRenewal))).toBe("decrease");
    // Our record of a downgrade waiting, or Polar's pending product.
    expect(classifyChange(TEAM, fewer, quote(atRenewal), true)).toBe("approval");
    expect(
      classifyChange(
        TEAM,
        fewer,
        quote({ ...atRenewal, basis: { ...basis, pendingProduct: "prod_team_month" } })
      )
    ).toBe("approval");
    // More seats are still a spend: Polar charges them at once.
    expect(classifyChange(TEAM, { kind: "seats", seats: 5 }, quote({ basis }), true)).toBe("spend");
  });

  it("runs fewer monthly blocks as a decrease, and keeps the rest of capacity for the owner", () => {
    const blocks = { units: 4, pendingUnits: null, cancelAtPeriodEnd: false, pastDue: false };
    const set = (n: number) => ({
      kind: "capacity" as const,
      capacity: { action: "set_monthly_blocks" as const, blocks: n },
    });
    expect(classifyChange(null, set(2), quote({ basis: { blocks } }))).toBe("decrease");
    expect(classifyChange(null, set(0), quote({ basis: { blocks } }))).toBe("decrease");
    expect(classifyChange(null, set(6), quote({ basis: { blocks } }))).toBe("approval");
    // Set to end: nothing renews, so nothing lowers it.
    expect(
      classifyChange(
        null,
        set(1),
        quote({ basis: { blocks: { ...blocks, cancelAtPeriodEnd: true } } })
      )
    ).toBe("approval");
    expect(
      classifyChange(
        null,
        { kind: "capacity", capacity: { action: "buy_blocks", blocks: 1 } },
        quote({ basis: { blocks } })
      )
    ).toBe("approval");
    expect(
      classifyChange(
        null,
        { kind: "capacity", capacity: { action: "set_overage", enabled: true, maxBlocks: 9 } },
        quote()
      )
    ).toBe("approval");
  });

  it("never spends on cancelling, resubscribing or keeping a plan", () => {
    for (const kind of ["cancel", "resubscribe", "keep_plan"] as const) {
      expect(classifyChange(null, { kind }, quote())).toBe("approval");
    }
  });
});

function state(overrides: Partial<BudgetAccountState> = {}): BudgetAccountState {
  return {
    ownerId: "u1",
    budgetCents: 5000,
    subscriptionId: "sub_1",
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    paid: true,
    addonPastDue: false,
    homeSite: "webhooks",
    version: {},
    ...overrides,
  };
}

describe("budgetStop", () => {
  const caller = { userId: "u1", keyId: "k1" };

  it("lets a live paid account with a budget spend", () => {
    expect(budgetStop(caller, state())).toBeNull();
  });

  it("stops a token with no account, another person's key, and a budget of 0", () => {
    expect(budgetStop({ userId: "", keyId: "k1" }, state())).toBe("pre_claim");
    expect(budgetStop({ userId: "u2", keyId: "k2" }, state())).toBe("not_owner");
    expect(budgetStop(caller, state({ budgetCents: 0 }))).toBe("budget_off");
  });

  it("stops while the plan, the team or an add-on is past due", () => {
    expect(budgetStop(caller, state({ subscriptionStatus: "past_due" }))).toBe("past_due");
    expect(budgetStop(caller, state({ addonPastDue: true }))).toBe("past_due");
  });

  it("stops without a live paid subscription", () => {
    expect(budgetStop(caller, state({ paid: false }))).toBe("no_subscription");
    expect(budgetStop(caller, state({ subscriptionId: null }))).toBe("no_subscription");
    expect(budgetStop(caller, state({ subscriptionStatus: null }))).toBe("no_subscription");
    expect(budgetStop(caller, state({ cancelAtPeriodEnd: true }))).toBe("no_subscription");
  });
});

describe("parseBudgetCents", () => {
  it("takes whole cents from 0 to $500", () => {
    expect(parseBudgetCents(0)).toBe(0);
    expect(parseBudgetCents(50_000)).toBe(50_000);
    expect(parseBudgetCents(50_001)).toBeNull();
    expect(parseBudgetCents(-1)).toBeNull();
    expect(parseBudgetCents(10.5)).toBeNull();
    expect(parseBudgetCents("100")).toBeNull();
  });
});

describe("idempotencyKeyFor", () => {
  const account = { userId: "u1", teamId: TEAM };
  const change = { kind: "seats" as const, seats: 5 };

  beforeAll(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key-for-tests");
  });

  it("keys the material with a server secret, so the stored key depends on it", () => {
    const key = idempotencyKeyFor(null, account, change, { seats: 3 });
    expect(key).toMatch(/^d:[0-9a-f]{64}$/);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "another-service-role-key");
    expect(idempotencyKeyFor(null, account, change, { seats: 3 })).not.toBe(key);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key-for-tests");
    expect(idempotencyKeyFor(null, account, change, { seats: 3 })).toBe(key);
  });

  it("derives another key once the billing period or what waits for the renewal moves", () => {
    const base = { seats: 3, pendingSeats: null, periodEnd: "2026-12-01T00:00:00.000Z" };
    const a = idempotencyKeyFor(null, account, change, base);
    expect(
      idempotencyKeyFor(null, account, change, { ...base, periodEnd: "2027-01-01T00:00:00.000Z" })
    ).not.toBe(a);
    expect(idempotencyKeyFor(null, account, change, { ...base, pendingSeats: 2 })).not.toBe(a);
    expect(idempotencyKeyFor(null, account, change, { ...base, pendingPlan: "team" })).not.toBe(a);
  });

  it("hashes a usable Idempotency-Key header with the billing account", () => {
    const key = idempotencyKeyFor("retry-0001-abc", account, change, {});
    expect(key).toMatch(/^h:[0-9a-f]{64}$/);
    expect(key).not.toContain("retry-0001-abc");
    // The header names the request, not the change: the same header for
    // another change finds the same row, which take_agent_budget refuses.
    expect(idempotencyKeyFor("retry-0001-abc", account, { kind: "seats", seats: 6 }, {})).toBe(key);
  });

  it("scopes a header key to one billing account", () => {
    const team = idempotencyKeyFor("retry-0001-abc", account, change, {});
    const otherTeam = idempotencyKeyFor(
      "retry-0001-abc",
      { userId: "u1", teamId: "7b4f0c8e-1d2b-4c5a-9e7f-0a1b2c3d4e5f" },
      change,
      {}
    );
    const own = idempotencyKeyFor("retry-0001-abc", { userId: "u1", teamId: null }, change, {});
    const otherPerson = idempotencyKeyFor(
      "retry-0001-abc",
      { userId: "u2", teamId: null },
      change,
      {}
    );
    expect(new Set([team, otherTeam, own, otherPerson]).size).toBe(4);
    // A team's key does not depend on which owner's key asked.
    expect(idempotencyKeyFor("retry-0001-abc", { userId: "u9", teamId: TEAM }, change, {})).toBe(
      team
    );
  });

  it("derives the same key for the same change on the same state, and another once it moves", () => {
    const a = idempotencyKeyFor(null, account, change, { seats: 3, subscriptionId: "s" });
    const b = idempotencyKeyFor(null, account, change, { subscriptionId: "s", seats: 3 });
    const moved = idempotencyKeyFor(null, account, change, { seats: 5, subscriptionId: "s" });
    const other = idempotencyKeyFor(null, account, { kind: "seats", seats: 6 }, { seats: 3 });
    expect(a).toBe(b);
    expect(a).toMatch(/^d:[0-9a-f]{64}$/);
    expect(moved).not.toBe(a);
    expect(other).not.toBe(a);
  });

  it("ignores a header too short, too long or with spaces", () => {
    for (const header of ["short", "x".repeat(201), "has space in it"]) {
      expect(usableIdempotencyHeader(header)).toBeNull();
      expect(idempotencyKeyFor(header, account, change, {})).toMatch(/^d:/);
    }
    expect(usableIdempotencyHeader("retry-0001-abc")).toBe("retry-0001-abc");
  });
});

describe("spendTarget", () => {
  it("names the seats a seat change reaches", () => {
    expect(spendTarget(TEAM, { kind: "seats", seats: 7 })).toEqual({ seats: 7 });
  });
});

describe("spendErrorKind (the give-back rule, as runLocked reads errors)", () => {
  it("gives back what certainly reached no charge: our allowlisted refusals and a declined card", () => {
    expect(spendErrorKind(new BillingChangeRefusal(409, "no", "unchanged"), 0)).toBe("refused");
    // Polar refuses an invoice-proration update with a declined card and
    // leaves the subscription unchanged (PaymentFailed, 402).
    expect(spendErrorKind(new TeamBillingError("payment_failed", "declined"), 1)).toBe("refused");
    expect(spendErrorKind(new BillingActionError("payment_failed", "declined"), 1)).toBe("refused");
    expect(spendErrorKind(new BillingActionError("plan_ending", "ending"), 0)).toBe("refused");
    expect(spendErrorKind(new TeamBillingError("seats_below_members", "members"), 0)).toBe(
      "refused"
    );
  });

  it("gives back a lease lost before anything reached Polar, never after", () => {
    expect(spendErrorKind(new BillingChangeRetry(503, "lease ran out"), 0)).toBe("retry");
    expect(spendErrorKind(new BillingChangeRetry(503, "lease ran out"), 1)).toBe("unknown");
  });

  it("keeps counted what may have been made: Polar errors, timeouts, writes after Polar, 3-D Secure", () => {
    expect(spendErrorKind(new PolarNetworkError("Request timed out"), 1)).toBe("unknown");
    expect(spendErrorKind(new Error("socket hang up"), 1)).toBe("unknown");
    expect(spendErrorKind(new TeamBillingError("seat_update_failed", "db"), 1)).toBe("unknown");
    // A raw 4xx from Polar is not on the allowlist (it may follow an earlier call that changed something).
    expect(spendErrorKind(new errors.HTTPValidationError(422, { detail: [] } as never), 1)).toBe(
      "unknown"
    );
    expect(spendErrorKind(new TeamBillingError("payment_action_required", "confirm it"), 1)).toBe(
      "payment_action"
    );
  });
});

describe("mayBeForBudget (no quote when the budget is off)", () => {
  it("names only the changes the budget could pay or run", () => {
    expect(mayBeForBudget(null, { kind: "plan", plan: "business", interval: "month" })).toBe(true);
    expect(mayBeForBudget(null, { kind: "plan", plan: "pro", interval: "month" })).toBe(false);
    expect(mayBeForBudget(null, { kind: "plan", plan: "business", interval: "year" })).toBe(false);
    expect(mayBeForBudget(TEAM, { kind: "plan", plan: "team_business", interval: "month" })).toBe(
      true
    );
    expect(mayBeForBudget(TEAM, { kind: "seats", seats: 4 })).toBe(true);
    expect(mayBeForBudget(null, { kind: "seats", seats: 4 })).toBe(false);
    expect(
      mayBeForBudget(null, {
        kind: "capacity",
        capacity: { action: "set_monthly_blocks", blocks: 1 },
      } as never)
    ).toBe(true);
    expect(mayBeForBudget(null, { kind: "cancel" })).toBe(false);
  });
});

describe("riseCounted (whether the renewal's rise counts on top)", () => {
  const facts = (annual: boolean) => ({
    creditAppliedCents: 0,
    renewalBeforeCents: 36_000,
    renewalAfterCents: 48_000,
    annual,
    currency: "usd",
  });
  const at = (periodEnd: string) => quote({ dueNowCents: 6000, basis: { periodEnd } });

  it("counts both on an annual plan whose renewal is at most 31 days away", () => {
    // An annual plan in its last days: the year's rise reaches the card in this window.
    expect(riseCounted(at("2026-11-30T12:00:00.000Z"), facts(true))).toBe(true);
    expect(budgetCostCents(at("2026-11-30T12:00:00.000Z"), facts(true))).toBe(18_000);
    expect(riseCounted(at("2026-12-14T12:00:00.000Z"), facts(false))).toBe(true);
    // A month of 31 days, quoted on its first: 31 days away, still both.
    expect(riseCounted(at("2026-12-15T12:00:00.000Z"), facts(false))).toBe(true);
    expect(budgetCostCents(at("2026-12-15T12:00:00.000Z"), facts(false))).toBe(18_000);
    expect(RISE_COUNTED_DAYS).toBe(31);
  });

  it("counts the larger of the two only on an annual plan whose renewal is further than 31 days", () => {
    expect(riseCounted(at("2027-06-01T00:00:00.000Z"), facts(true))).toBe(false);
    expect(budgetCostCents(at("2027-06-01T00:00:00.000Z"), facts(true))).toBe(12_000);
    expect(riseCounted(at("2026-12-15T12:00:01.000Z"), facts(true))).toBe(false);
  });

  it("always counts both on a monthly subscription, whatever its period says", () => {
    // A monthly period Polar shows further than 31 days away (moved later,
    // or a short month's alignment): the rise still counts on top.
    expect(riseCounted(at("2026-12-15T12:00:01.000Z"), facts(false))).toBe(true);
    expect(budgetCostCents(at("2026-12-15T12:00:01.000Z"), facts(false))).toBe(18_000);
    expect(riseCounted(at("2027-06-01T00:00:00.000Z"), facts(false))).toBe(true);
  });

  it("falls back to the interval when the quote names no period", () => {
    expect(riseCounted(quote(), facts(false))).toBe(true);
    expect(riseCounted(quote(), facts(true))).toBe(false);
  });
});

describe("replayBodyOf (a spend a webhook made, answered again)", () => {
  it("builds the answer from the spend's row", () => {
    expect(
      replayBodyOf({
        id: "spend-1",
        description: "Change the team from 3 to 5 seats.",
        amount_cents: 3600,
        facts: { chargeCents: 1200, renewalCents: 6000, renewalRiseCents: 2400, riseCounted: true },
      })
    ).toMatchObject({
      executed: true,
      applied: "now",
      change: "Change the team from 3 to 5 seats.",
      chargedCents: 1200,
      countedCents: 3600,
      renewalRiseCents: 2400,
      riseCounted: true,
      budget: { spendId: "spend-1" },
      viaBudget: true,
    });
  });
});

describe("budgetCostCents (what a change counts against the budget)", () => {
  const monthly = (before: number, after: number, credit = 0) => ({
    creditAppliedCents: credit,
    renewalBeforeCents: before,
    renewalAfterCents: after,
    annual: false,
    currency: "usd",
  });

  it("counts the charge now plus the rise of the next renewal on a monthly subscription", () => {
    // Two $12 seats with half a month left: about $12 now, the renewal $24 higher.
    const facts = monthly(3600, 6000);
    expect(renewalRiseCents(facts)).toBe(2400);
    expect(budgetCostCents(quote({ dueNowCents: 1200 }), facts)).toBe(3600);
    expect(budgetCostCents(quote({ dueNowCents: 1600 }), monthly(6000, 6100))).toBe(1700);
  });

  it("never counts a fall of the renewal", () => {
    const lower = monthly(6000, 3000);
    expect(renewalRiseCents(lower)).toBe(0);
    expect(budgetCostCents(quote({ dueNowCents: 500 }), lower)).toBe(500);
  });

  it("counts the larger of the two on an annual subscription: a seat at the full year's price", () => {
    const annual = { ...monthly(36_000, 48_000), annual: true };
    expect(budgetCostCents(quote({ dueNowCents: 6000 }), annual)).toBe(12_000);
    const charge = { ...monthly(36_000, 36_100), annual: true };
    expect(budgetCostCents(quote({ dueNowCents: 6000 }), charge)).toBe(6000);
  });

  it("takes the charge before account credit, so credit never lets a large change pass at 0", () => {
    expect(budgetCostCents(quote({ dueNowCents: 0 }), monthly(2900, 2900, 4000))).toBe(4000);
    expect(budgetCostCents(quote({ dueNowCents: 0 }), monthly(2900, 3900, 4000))).toBe(5000);
  });

  it("takes the most a prorated charge can move when the quote is approximate", () => {
    const facts = monthly(0, 0);
    expect(budgetCostCents(quote({ dueNowCents: 1985, approximate: true }), facts)).toBe(
      chargeCeiling(1985)
    );
    expect(budgetCostCents(quote({ dueNowCents: 1985, approximate: false }), facts)).toBe(1985);
    expect(
      budgetCostCents(quote({ dueNowCents: 1985, approximate: true }), monthly(2900, 4900))
    ).toBe(chargeCeiling(1985) + 2000);
  });
});

describe("orderSeats (the seats a paid order bought)", () => {
  it("takes the order's seats, else its subscription's", () => {
    expect(orderSeats({ seats: 5, subscription: { seats: 4 } })).toBe(5);
    expect(orderSeats({ seats: null, subscription: { seats: 4 } })).toBe(4);
    expect(orderSeats({ subscription: null })).toBeNull();
    expect(orderSeats({})).toBeNull();
  });
});

describe("resendRefusal (sending a spend whose outcome is not known again)", () => {
  const periodEnd = "2026-12-01T00:00:00.000Z";
  const existing = {
    ageSeconds: 60,
    quotedCents: 2400,
    amountCents: 2400,
    periodEnd: "2026-12-01T00:00:00+00:00",
    budgetCents: 10_000,
    othersCents: 1000,
  };

  it("sends it again while it is fresh, in its period, at its price and within the budget", () => {
    expect(resendRefusal(existing, { costCents: 2400, periodEnd })).toBeNull();
    // Time alone moves a prorated charge by a cent or so.
    expect(resendRefusal(existing, { costCents: chargeCeiling(2400), periodEnd })).toBeNull();
  });

  it("refuses one taken too long ago", () => {
    expect(
      resendRefusal(
        { ...existing, ageSeconds: RESEND_MAX_AGE_SECONDS + 1 },
        { costCents: 2400, periodEnd }
      )
    ).toBe("too_old");
  });

  it("refuses once the billing period moved, or when it is not known", () => {
    expect(
      resendRefusal(existing, { costCents: 2400, periodEnd: "2027-01-01T00:00:00.000Z" })
    ).toBe("period_moved");
    expect(resendRefusal({ ...existing, periodEnd: null }, { costCents: 2400, periodEnd })).toBe(
      "period_moved"
    );
  });

  it("refuses at a higher price than it was counted at", () => {
    expect(resendRefusal(existing, { costCents: chargeCeiling(2400) + 1, periodEnd })).toBe(
      "price_rose"
    );
  });

  it("refuses when the budget less the other spends no longer covers it", () => {
    expect(resendRefusal({ ...existing, budgetCents: 3000 }, { costCents: 2400, periodEnd })).toBe(
      "over_budget"
    );
  });
});

describe("keyLabelOf", () => {
  const rlo = String.fromCharCode(0x202e);
  const newline = String.fromCharCode(10);

  it("cleans and caps names a key's maker or an agent chose", () => {
    const label = keyLabelOf({
      name: `deploy${rlo} "bot"${newline}Approve now ${"x".repeat(200)}`,
      key_prefix: "whcc_abc1234",
      is_agent_issued: false,
      client_name: null,
    });
    // Control characters go (a newline too, so the lines join).
    expect(label.startsWith('the API key "deploy botApprove now')).toBe(true);
    expect(label).not.toContain(rlo);
    expect(label).not.toContain(newline);
    expect(label.length).toBeLessThan(120);
    expect(label.endsWith('" (whcc_abc1234...)')).toBe(true);
  });

  it("names an agent by its client name, and falls back when nothing is left", () => {
    expect(
      keyLabelOf({ name: "k", key_prefix: "p", is_agent_issued: true, client_name: "Claude Code" })
    ).toBe('the agent "Claude Code"');
    expect(
      keyLabelOf({ name: `"${rlo}"`, key_prefix: "", is_agent_issued: false, client_name: null })
    ).toBe("an API key");
  });
});
