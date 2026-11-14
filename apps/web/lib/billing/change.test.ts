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
  },
  updates: [] as number[],
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
    name: "Acme",
    seats: polar.state.seats,
    pending_seats: polar.state.pendingSeats,
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
    resubscribeTeam: vi.fn(),
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
  capacityQuote,
  chargeCeiling,
  loadBillingQuote,
  parseBillingChangeRequest,
  quoteFingerprint,
  runBillingChange,
} = await import("./change");
const teamBilling = await import("@/lib/supabase/team-billing");

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
  };
  polar.updates = [];
  vi.mocked(teamBilling.updateTeamSeats).mockClear();
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
    expect(quote.change).toBe('Change the team "Acme" from 3 to 5 seats.');
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
    const outcome = await runBillingChange("owner", ask, approved);
    expect(outcome).toEqual({ executed: true, applied: "now" });
    expect(polar.updates).toEqual([5]);
  });

  test("a replay of the same approval changes and charges nothing", async () => {
    const approved = await quoteNow();
    await runBillingChange("owner", ask, approved);
    const again = await runBillingChange("owner", ask, approved);
    expect(again.executed).toBe(false);
    expect(polar.updates).toEqual([5]);
  });

  test("a price change since the ask refuses, and nothing changes", async () => {
    const approved = await quoteNow();
    polar.state.amount = 4500; // $15 a seat now
    const outcome = await runBillingChange("owner", ask, approved);
    expect(outcome).toMatchObject({ executed: false, code: "quote_changed" });
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
  });

  test("a renewal since the ask (a new period) refuses", async () => {
    const approved = await quoteNow();
    polar.state.periodStart = Date.parse("2026-12-01T00:00:00Z");
    polar.state.periodEnd = Date.parse("2027-01-01T00:00:00Z");
    const outcome = await runBillingChange("owner", ask, approved);
    expect(outcome).toMatchObject({ executed: false, code: "quote_changed" });
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
  });

  test("credit spent elsewhere since the ask refuses", async () => {
    polar.state.credit = 500;
    const approved = await quoteNow();
    polar.state.credit = 0;
    const outcome = await runBillingChange("owner", ask, approved);
    expect(outcome.executed).toBe(false);
  });

  test("a subscription that ended since the ask refuses with the reason", async () => {
    const approved = await quoteNow();
    polar.state.status = "canceled";
    const outcome = await runBillingChange("owner", ask, approved);
    expect(outcome).toMatchObject({ executed: false, code: "quote_changed" });
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
  });

  test("a quote edited to look cheaper never runs", async () => {
    const approved = await quoteNow();
    const outcome = await runBillingChange("owner", ask, { ...approved, dueNowCents: 1 });
    expect(outcome.executed).toBe(false);
    expect(teamBilling.updateTeamSeats).not.toHaveBeenCalled();
  });

  test("an error after Polar may have acted propagates (no second try)", async () => {
    const approved = await quoteNow();
    vi.mocked(teamBilling.updateTeamSeats).mockRejectedValueOnce(new Error("socket hang up"));
    await expect(runBillingChange("owner", ask, approved)).rejects.toThrow("socket hang up");
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
