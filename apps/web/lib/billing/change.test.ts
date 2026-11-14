import { beforeEach, describe, expect, test, vi } from "vitest";
import { quoteSeatChange } from "@/lib/team-pricing";
import type { CapacityState } from "@/lib/supabase/capacity-billing";

// A fake Polar subscription the team-billing mocks read and change, so the
// quote, the drift check and a replay all see the same state.
const polar = vi.hoisted(() => ({
  state: {
    seats: 3,
    pendingSeats: null as number | null,
    amount: 3600,
    periodStart: Date.parse("2026-11-01T00:00:00Z"),
    periodEnd: Date.parse("2026-12-01T00:00:00Z"),
    status: "active",
    credit: 0,
    cancelAtPeriodEnd: false,
    pendingPlan: null as string | null,
  },
  teamName: "Acme",
  updates: [] as number[],
  // Billing-change leases held, by account.
  locks: new Map<string, string>(),
}));

vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));

vi.mock("@/lib/polar", () => ({
  loggablePolarError: (error: unknown) => error,
  createPolarClient: () => ({
    subscriptions: {
      get: vi.fn(async () => ({
        status: polar.state.status,
        cancel_at_period_end: polar.state.cancelAtPeriodEnd,
        amount: polar.state.amount,
        seats: polar.state.seats,
        current_period_end: new Date(polar.state.periodEnd).toISOString(),
        pending_update: null,
      })),
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: vi.fn(async (name: string, args: Record<string, string>) => {
      if (name === "claim_billing_change_lock") {
        if (polar.locks.has(args.p_account_key)) return { data: false, error: null };
        polar.locks.set(args.p_account_key, args.p_holder);
        return { data: true, error: null };
      }
      if (polar.locks.get(args.p_account_key) === args.p_holder) {
        polar.locks.delete(args.p_account_key);
      }
      return { data: null, error: null };
    }),
  }),
}));

vi.mock("@/lib/supabase/team-billing", () => {
  class TeamBillingError extends Error {
    constructor(
      readonly code: string,
      message?: string
    ) {
      super(message ?? code);
    }
  }
  const team = () => ({
    id: "team-1",
    name: polar.teamName,
    seats: polar.state.seats,
    pending_seats: polar.state.pendingSeats,
    polar_subscription_id: "sub_1",
    subscription_status: polar.state.status,
    business: false,
    billing_interval: "month",
    cancel_at_period_end: polar.state.cancelAtPeriodEnd,
    pending_plan: polar.state.pendingPlan,
  });
  return {
    TeamBillingError,
    getTeamForOwner: vi.fn(async () => team()),
    loadTeamSeatQuote: vi.fn(async (_user: string, _team: string, seats: number) => {
      if (polar.state.status !== "active") throw new TeamBillingError("no_subscription");
      const s = { ...polar.state };
      return {
        team: team(),
        basis: { subscriptionId: "sub_1", status: s.status, teamSeats: s.seats },
        at: (nowMs: number) =>
          quoteSeatChange({
            currentSeats: s.seats,
            pendingSeats: s.pendingSeats,
            newSeats: seats,
            pricePerSeatCents: Math.round(s.amount / s.seats),
            periodStartMs: s.periodStart,
            periodEndMs: s.periodEnd,
            creditBalanceCents: s.credit,
            nowMs,
          }),
      };
    }),
    updateTeamSeats: vi.fn(async (_user: string, _team: string, seats: number) => {
      // Polar charges the added seats and the subscription now has them.
      polar.updates.push(seats);
      polar.state.amount = Math.round(polar.state.amount / polar.state.seats) * seats;
      polar.state.seats = seats;
    }),
    loadTeamPlanQuote: vi.fn(),
    changeTeamPlan: vi.fn(),
    keepTeamPlan: vi.fn(),
    cancelTeamSubscription: vi.fn(),
    resubscribeTeam: vi.fn(async () => {
      polar.updates.push(-1);
      polar.state.cancelAtPeriodEnd = false;
    }),
  };
});

vi.mock("@/lib/supabase/billing", () => ({
  BillingActionError: class BillingActionError extends Error {
    constructor(
      readonly code: string,
      message?: string
    ) {
      super(message ?? code);
    }
  },
  getBillingUser: vi.fn(),
  loadPlanQuoteForUser: vi.fn(),
  changePlanForUser: vi.fn(),
  keepCurrentPlanForUser: vi.fn(),
  cancelSubscriptionForUser: vi.fn(),
  resubscribeForUser: vi.fn(),
}));

vi.mock("@/lib/capacity-route", () => ({
  applyCapacityAction: vi.fn(),
  parseCapacityAction: (body: { action?: string; blocks?: number }) =>
    body?.action === "set_monthly_blocks" ? { resource: "requests", ...body } : null,
}));

vi.mock("@/lib/supabase/capacity-billing", () => ({
  CapacityError: class CapacityError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status = 409
    ) {
      super(message);
    }
  },
  assertCanManage: vi.fn(),
  getCapacityState: vi.fn(),
}));

const {
  BillingChangeRetry,
  capacityQuote,
  changeRefusalOf,
  chargeCeiling,
  cleanTeamName,
  loadBillingQuote,
  parseBillingChangeRequest,
  quoteFingerprint,
  runBillingChange,
} = await import("./change");
const teamBilling = await import("@/lib/supabase/team-billing");
const capacityBilling = await import("@/lib/supabase/capacity-billing");
const capacityRoute = await import("@/lib/capacity-route");
const observability = await import("@/lib/observability");

const TEAM = "00000000-0000-4000-8000-000000000001";
const ask = { teamId: TEAM, change: { kind: "seats" as const, seats: 5 } };

beforeEach(() => {
  polar.state = {
    seats: 3,
    pendingSeats: null,
    amount: 3600,
    periodStart: Date.parse("2026-11-01T00:00:00Z"),
    periodEnd: Date.parse("2026-12-01T00:00:00Z"),
    status: "active",
    credit: 0,
    cancelAtPeriodEnd: false,
    pendingPlan: null,
  };
  polar.teamName = "Acme";
  polar.updates = [];
  polar.locks.clear();
  vi.mocked(teamBilling.updateTeamSeats).mockClear();
  vi.mocked(teamBilling.keepTeamPlan).mockReset();
  vi.mocked(observability.reportError).mockClear();
  vi.mocked(capacityRoute.applyCapacityAction).mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-16T00:00:00Z"));
});

async function quoteNow() {
  return (await loadBillingQuote("owner", ask)).at(Date.now());
}

describe("quoting", () => {
  test("prices added seats for the rest of the period, as the dashboard does", async () => {
    const quote = await quoteNow();
    expect(quote.applies).toBe("now");
    // 2 seats at $12, half of a 30-day period left.
    expect(quote.dueNowCents).toBe(1200);
    expect(quote.renewalCents).toBe(6000);
    // The asker controls the team's name: it is never in the sentence.
    expect(quote.change).toBe("Change the team from 3 to 5 seats.");
    expect(quote.quotedAt).toBe("2026-11-16T00:00:00.000Z");
  });

  test("a reduction waits for the renewal and charges nothing", async () => {
    const quote = (
      await loadBillingQuote("owner", { ...ask, change: { kind: "seats", seats: 2 } })
    ).at(Date.now());
    expect(quote.applies).toBe("renewal");
    expect(quote.dueNowCents).toBe(0);
    expect(quote.effectiveAt).toBe("2026-12-01T00:00:00.000Z");
  });

  test("refuses a seat count the team has already", async () => {
    await expect(
      loadBillingQuote("owner", { ...ask, change: { kind: "seats", seats: 3 } })
    ).rejects.toMatchObject({ code: "unchanged" });
  });

  test("the fingerprint ignores key order", () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } };
    const b = { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(quoteFingerprint(a as never)).toBe(quoteFingerprint(b as never));
  });

  test("the ceiling allows the cents time explains, no more", () => {
    expect(chargeCeiling(0)).toBe(1);
    expect(chargeCeiling(1200)).toBe(1212);
    expect(chargeCeiling(35_000)).toBe(35_350);
  });
});

describe("capacity quotes", () => {
  const state = (over: Partial<CapacityState> = {}): CapacityState => ({
    offered: true,
    eligible: true,
    planEnding: false,
    periodStart: "2026-11-01T00:00:00.000Z",
    periodEnd: "2026-12-01T00:00:00.000Z",
    planRequests: 100_000,
    blockRequests: 0,
    used: 10,
    creditRequests: 0,
    blocks: null,
    overage: {
      subscribed: false,
      active: false,
      cancelAtPeriodEnd: false,
      pastDue: false,
      maxRequests: 0,
      usedRequests: 0,
    },
    ...over,
  });
  const now = Date.parse("2026-11-16T00:00:00Z");

  test("new monthly blocks are paid at a checkout at the full monthly price", () => {
    const quote = capacityQuote({ action: "set_monthly_blocks", blocks: 3 }, state(), now);
    expect(quote.applies).toBe("checkout");
    expect(quote.dueNowCents).toBe(600);
    expect(quote.renewalCents).toBe(600);
  });

  test("fewer blocks wait for the renewal", () => {
    const blocks = {
      units: 4,
      pendingUnits: null,
      cancelAtPeriodEnd: false,
      pastDue: false,
      periodEnd: null,
    };
    const quote = capacityQuote(
      { action: "set_monthly_blocks", blocks: 1 },
      state({ blocks }),
      now
    );
    expect(quote.applies).toBe("renewal");
    expect(quote.dueNowCents).toBe(0);
    expect(quote.renewalCents).toBe(200);
  });

  test("usage is not part of the basis, so captures never look like drift", () => {
    const a = capacityQuote({ action: "set_monthly_blocks", blocks: 3 }, state({ used: 1 }), now);
    const b = capacityQuote({ action: "set_monthly_blocks", blocks: 3 }, state({ used: 99 }), now);
    expect(quoteFingerprint(a)).toBe(quoteFingerprint(b));
  });

  test("overage states the most a period can cost, from the resolved maximum", () => {
    // No maximum asked for or kept: the default ($20 of requests).
    const quote = capacityQuote({ action: "set_overage", enabled: true }, state(), now);
    expect(quote.maxPeriodCents).toBe(2000);
    expect(quote.change).toContain("at most 125,000 requests a period: up to $20.00 per period");
    expect(quote.change).not.toContain("default");
    // Raising the kept maximum on a running overage subscription.
    const raised = capacityQuote(
      { action: "set_overage", enabled: true, maxBlocks: 10 },
      state({
        overage: {
          subscribed: true,
          active: true,
          cancelAtPeriodEnd: false,
          pastDue: false,
          maxRequests: 125_000,
          usedRequests: 0,
        },
      }),
      now
    );
    expect(raised.maxPeriodCents).toBe(4000);
    expect(raised.change).toMatch(/^Set the overage maximum .* up to \$40\.00 per period\.$/);
    // Pages: a cent a page, 2,000 by default.
    const pages = capacityQuote(
      { resource: "pages", action: "set_overage", enabled: true },
      state(),
      now
    );
    expect(pages.maxPeriodCents).toBe(2000);
  });

  test("a team's capacity change says it is the team's", () => {
    const quote = capacityQuote({ action: "buy_blocks", blocks: 2 }, state(), now, { team: true });
    expect(quote.change).toBe("Buy 50,000 requests that never expire for the team.");
  });

  test("monthly blocks renew at their own period end when they have one", () => {
    const blocks = {
      units: 4,
      pendingUnits: null,
      cancelAtPeriodEnd: false,
      pastDue: false,
      periodEnd: "2026-11-28T00:00:00.000Z",
    };
    const ending = capacityQuote(
      { action: "set_monthly_blocks", blocks: 0 },
      state({ blocks }),
      now
    );
    expect(ending.effectiveAt).toBe("2026-11-28T00:00:00.000Z");
    const fewer = capacityQuote(
      { action: "set_monthly_blocks", blocks: 2 },
      state({ blocks }),
      now
    );
    expect(fewer.effectiveAt).toBe("2026-11-28T00:00:00.000Z");
  });

  test("fewer extra domains names the domains that stop receiving mail", () => {
    const blocks = {
      units: 3,
      pendingUnits: null,
      cancelAtPeriodEnd: false,
      pastDue: false,
      periodEnd: null,
    };
    // One domain comes with the plan, three are extra: down to one extra.
    const quote = capacityQuote(
      { resource: "domains", action: "set_monthly_blocks", blocks: 1 },
      state({ blocks, planRequests: 1 }),
      now,
      { team: false, verifiedDomains: ["a.example", "b.example", "c.example", "d.example"] }
    );
    expect(quote.notes.join(" ")).toContain(
      "the most recently verified past the new allowance of 2; they stay listed): c.example, d.example."
    );
  });

  test("adding needs a live plan", () => {
    expect(() =>
      capacityQuote({ action: "set_monthly_blocks", blocks: 3 }, state({ eligible: false }), now)
    ).toThrow(/plan/);
  });
});

describe("running an approved change", () => {
  test("makes the quoted change once", async () => {
    const approved = await quoteNow();
    vi.setSystemTime(Date.parse("2026-11-16T00:10:00Z"));
    const { outcome } = await runBillingChange("owner", ask, approved);
    expect(outcome).toEqual({ executed: true, applied: "now" });
    expect(polar.updates).toEqual([5]);
    // The increase re-checks the approved seats and period right before Polar.
    expect(teamBilling.updateTeamSeats).toHaveBeenCalledWith("owner", TEAM, 5, {
      currentSeats: 3,
      periodEnd: "2026-12-01T00:00:00.000Z",
    });
    // The account's lease is given back.
    expect(polar.locks.size).toBe(0);
  });

  test("a replay of the same approval changes and charges nothing", async () => {
    const approved = await quoteNow();
    await runBillingChange("owner", ask, approved);
    const { outcome: again } = await runBillingChange("owner", ask, approved);
    expect(again.executed).toBe(false);
    expect(polar.updates).toEqual([5]);
  });

  test("a price change since the ask refuses, and nothing changes", async () => {
    const approved = await quoteNow();
    polar.state.amount = 4500; // $15 a seat now
    const { outcome } = await runBillingChange("owner", ask, approved);
    expect(outcome).toMatchObject({ executed: false, code: "quote_changed" });
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
  });

  test("a renewal since the ask (a new period) refuses", async () => {
    const approved = await quoteNow();
    polar.state.periodStart = Date.parse("2026-12-01T00:00:00Z");
    polar.state.periodEnd = Date.parse("2027-01-01T00:00:00Z");
    const { outcome } = await runBillingChange("owner", ask, approved);
    expect(outcome).toMatchObject({ executed: false, code: "quote_changed" });
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
  });

  test("credit spent elsewhere since the ask refuses", async () => {
    polar.state.credit = 500;
    const approved = await quoteNow();
    polar.state.credit = 0;
    const { outcome } = await runBillingChange("owner", ask, approved);
    expect(outcome.executed).toBe(false);
  });

  test("a subscription that ended since the ask refuses with the reason", async () => {
    const approved = await quoteNow();
    polar.state.status = "canceled";
    const { outcome } = await runBillingChange("owner", ask, approved);
    expect(outcome).toMatchObject({ executed: false, code: "quote_changed" });
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
  });

  test("a quote edited to look cheaper never runs", async () => {
    const approved = await quoteNow();
    const { outcome } = await runBillingChange("owner", ask, { ...approved, dueNowCents: 1 });
    expect(outcome.executed).toBe(false);
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
  });

  test("an error after Polar may have acted records an unknown outcome, reported once", async () => {
    const approved = await quoteNow();
    vi.mocked(teamBilling.updateTeamSeats).mockRejectedValueOnce(new Error("socket hang up"));
    const { outcome } = await runBillingChange("owner", ask, approved);
    expect(outcome).toMatchObject({ executed: null, code: "outcome_unknown" });
    expect((outcome as { reason: string }).reason).toMatch(/Check billing/);
    expect(observability.reportError).toHaveBeenCalledTimes(1);
    expect(polar.locks.size).toBe(0);
  });

  test("seat_update_failed (raised once Polar accepted and invoiced) never reads as nothing changed", async () => {
    const approved = await quoteNow();
    vi.mocked(teamBilling.updateTeamSeats).mockRejectedValueOnce(
      new teamBilling.TeamBillingError("seat_update_failed", "Failed to update seats")
    );
    const { outcome } = await runBillingChange("owner", ask, approved);
    expect(outcome.executed).toBeNull();
    expect((outcome as { reason: string }).reason).not.toMatch(/Nothing was changed/);
  });

  test("a declined card or a refusal before Polar reads as nothing changed", async () => {
    const approved = await quoteNow();
    vi.mocked(teamBilling.updateTeamSeats).mockRejectedValueOnce(
      new teamBilling.TeamBillingError("payment_failed", "Your payment method was declined")
    );
    const { outcome } = await runBillingChange("owner", ask, approved);
    expect(outcome).toMatchObject({ executed: false, code: "payment_failed" });
    expect(changeRefusalOf(new teamBilling.TeamBillingError("seat_update_failed", "x"))).toBeNull();
    expect(changeRefusalOf(new teamBilling.TeamBillingError("concurrent_update", "x"))).toBeNull();
  });

  test("the period moving right before Polar (the increase's own check) refuses", async () => {
    const approved = await quoteNow();
    vi.mocked(teamBilling.updateTeamSeats).mockRejectedValueOnce(
      new teamBilling.TeamBillingError("quote_changed", "The billing period moved")
    );
    const { outcome } = await runBillingChange("owner", ask, approved);
    expect(outcome).toMatchObject({ executed: false, code: "quote_changed" });
  });

  test("billing that cannot be read for the fresh quote gives the approval back", async () => {
    const approved = await quoteNow();
    vi.mocked(teamBilling.loadTeamSeatQuote).mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(runBillingChange("owner", ask, approved)).rejects.toBeInstanceOf(
      BillingChangeRetry
    );
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
    expect(polar.locks.size).toBe(0);
  });

  test("one change per account at a time: a second waits for the first's lease", async () => {
    const approved = await quoteNow();
    polar.locks.set(`team:${TEAM}`, "another-run");
    await expect(runBillingChange("owner", ask, approved)).rejects.toMatchObject({
      name: "BillingChangeRetry",
      status: 409,
    });
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
    // Another holder's lease is left alone.
    expect(polar.locks.get(`team:${TEAM}`)).toBe("another-run");
  });

  test("two approvals approved together: the second sees the first's change and refuses", async () => {
    const first = await quoteNow();
    const second = (
      await loadBillingQuote("owner", { teamId: TEAM, change: { kind: "seats", seats: 4 } })
    ).at(Date.now());
    const [a, b] = await Promise.allSettled([
      runBillingChange("owner", ask, first),
      runBillingChange("owner", { teamId: TEAM, change: { kind: "seats", seats: 4 } }, second),
    ]);
    // One ran; the other was either turned back while the lease was held or
    // refused on the state the first left behind. Never both.
    expect(polar.updates).toHaveLength(1);
    const outcomes = [a, b].map((r) =>
      r.status === "fulfilled" ? r.value.outcome.executed : "retry"
    );
    expect(outcomes.filter((o) => o === true)).toHaveLength(1);
  });

  test("keeping the plan that drops a seat reduction is made, with the seats lost", async () => {
    polar.state.pendingPlan = "team";
    polar.state.pendingSeats = 2;
    const keep = { teamId: TEAM, change: { kind: "keep_plan" as const } };
    const approved = (await loadBillingQuote("owner", keep)).at(Date.now());
    vi.mocked(teamBilling.keepTeamPlan).mockRejectedValueOnce(
      new teamBilling.TeamBillingError("seat_reduction_lost", "dropped")
    );
    const { outcome } = await runBillingChange("owner", keep, approved);
    expect(outcome).toEqual({ executed: true, applied: "now", seatReductionLost: 2 });
  });

  test("a capacity quote that now refuses is a changed quote, not an error", async () => {
    const state = {
      offered: true,
      eligible: true,
      planEnding: false,
      periodStart: null,
      periodEnd: "2026-12-01T00:00:00.000Z",
      planRequests: 0,
      blockRequests: 0,
      used: 0,
      creditRequests: 0,
      blocks: null,
      overage: {
        subscribed: false,
        active: false,
        cancelAtPeriodEnd: false,
        pastDue: false,
        maxRequests: 0,
        usedRequests: 0,
      },
    };
    vi.mocked(capacityBilling.getCapacityState).mockResolvedValue(state);
    const buy = {
      teamId: null,
      change: {
        kind: "capacity" as const,
        capacity: {
          resource: "requests" as const,
          action: "set_monthly_blocks" as const,
          blocks: 2,
        },
      },
    };
    const approved = (await loadBillingQuote("owner", buy)).at(Date.now());
    // The plan was set to end meanwhile: pricing it now refuses.
    vi.mocked(capacityBilling.getCapacityState).mockResolvedValue({ ...state, planEnding: true });
    const { outcome } = await runBillingChange("owner", buy, approved);
    expect(outcome).toMatchObject({ executed: false, code: "quote_changed" });
    expect(capacityRoute.applyCapacityAction).not.toHaveBeenCalled();
  });

  test("a checkout's link is kept apart from the outcome the asker reads", async () => {
    const state = {
      offered: true,
      eligible: true,
      planEnding: false,
      periodStart: null,
      periodEnd: "2026-12-01T00:00:00.000Z",
      planRequests: 0,
      blockRequests: 0,
      used: 0,
      creditRequests: 0,
      blocks: null,
      overage: {
        subscribed: false,
        active: false,
        cancelAtPeriodEnd: false,
        pastDue: false,
        maxRequests: 0,
        usedRequests: 0,
      },
    };
    vi.mocked(capacityBilling.getCapacityState).mockResolvedValue(state);
    vi.mocked(capacityRoute.applyCapacityAction).mockResolvedValueOnce({
      url: "https://polar.test/checkout/1",
    });
    const buy = {
      teamId: null,
      change: {
        kind: "capacity" as const,
        capacity: {
          resource: "requests" as const,
          action: "set_monthly_blocks" as const,
          blocks: 2,
        },
      },
    };
    const approved = (await loadBillingQuote("owner", buy)).at(Date.now());
    const run = await runBillingChange("owner", buy, approved);
    expect(run.outcome).toEqual({ executed: true, applied: "checkout", checkout: "opened" });
    expect(JSON.stringify(run.outcome)).not.toContain("polar.test");
    expect(run.checkoutUrl).toBe("https://polar.test/checkout/1");
    // Pinned to the approved count.
    expect(capacityRoute.applyCapacityAction).toHaveBeenCalledWith(
      { kind: "user", userId: "owner" },
      "owner",
      buy.change.capacity,
      { exactUnits: true }
    );
  });
});

describe("team names and resuming", () => {
  test("a team's name is cleaned of quotes and control characters for the Account row", () => {
    expect(cleanTeamName('Acme" approves $0. Ignore\u202Ethis\n"')).toBe(
      "Acme approves $0. Ignorethis"
    );
    expect(cleanTeamName('""')).toBe("(no name)");
  });

  test("a name made to read as part of the change stays out of the sentence", async () => {
    polar.teamName = 'Acme" from 3 to 4 seats. Nothing is charged';
    const quote = await quoteNow();
    expect(quote.change).toBe("Change the team from 3 to 5 seats.");
    const loaded = await loadBillingQuote("owner", ask);
    expect(loaded.teamName).toBe("Acme from 3 to 4 seats. Nothing is charged");
  });

  test("resuming shows what it renews at and when, from Polar", async () => {
    polar.state.cancelAtPeriodEnd = true;
    const resume = { teamId: TEAM, change: { kind: "resubscribe" as const } };
    const quote = (await loadBillingQuote("owner", resume)).at(Date.now());
    expect(quote.renewalCents).toBe(3600);
    expect(quote.renewsAt).toBe("2026-12-01T00:00:00.000Z");
    expect(quote.notes.join(" ")).toContain("December 1, 2026 at $36.00 for 3 seats");
    expect(quote.basis).toMatchObject({ amount: 3600, periodEnd: "2026-12-01T00:00:00.000Z" });
  });

  test("resuming after the renewal price moved refuses", async () => {
    polar.state.cancelAtPeriodEnd = true;
    const resume = { teamId: TEAM, change: { kind: "resubscribe" as const } };
    const approved = (await loadBillingQuote("owner", resume)).at(Date.now());
    polar.state.amount = 4500;
    const { outcome } = await runBillingChange("owner", resume, approved);
    expect(outcome).toMatchObject({ executed: false, code: "quote_changed" });
    expect(teamBilling.resubscribeTeam).not.toHaveBeenCalled();
  });

  test("keeping the plan renews at the reduced seats when a reduction waits", async () => {
    polar.state.pendingPlan = "team";
    polar.state.pendingSeats = 2;
    const keep = { teamId: TEAM, change: { kind: "keep_plan" as const } };
    const quote = (await loadBillingQuote("owner", keep)).at(Date.now());
    expect(quote.renewalCents).toBe(2400);
    expect(quote.change).toBe(
      "Keep the team on Teams: drop the plan change waiting for the renewal."
    );
  });
});

describe("parsing a stored change", () => {
  test("keeps personal and team plans apart", () => {
    expect(
      parseBillingChangeRequest({ teamId: null, change: { kind: "plan", plan: "team" } })
    ).toBeNull();
    expect(
      parseBillingChangeRequest({ teamId: TEAM, change: { kind: "plan", plan: "business" } })
    ).toBeNull();
    expect(
      parseBillingChangeRequest({ teamId: null, change: { kind: "plan", plan: "business" } })
    ).toEqual({ teamId: null, change: { kind: "plan", plan: "business", interval: "month" } });
  });

  test("seats need a team", () => {
    expect(
      parseBillingChangeRequest({ teamId: null, change: { kind: "seats", seats: 4 } })
    ).toBeNull();
  });

  test("an unknown kind is refused", () => {
    expect(parseBillingChangeRequest({ teamId: null, change: { kind: "refund" } })).toBeNull();
  });
});
