import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

// take_agent_budget() and the functions around it (migration 00107),
// straight against the database: the take is one conditional statement
// serialised on the account row, so these run takes at the same time.

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** What the take and state functions answer: a status and its numbers. */
interface TakeResult {
  status: string;
  id: string;
  left: number;
  needed: number;
  budget: number;
  spent: number;
  others: number;
  quoted_cents: number;
  amount_cents: number;
  period_end: string | null;
  age_seconds: number;
}

const ts = Date.now();
const SUB = `sub_abt_${ts}`;
let userId: string;

const BUSINESS = { kind: "plan", plan: "business", interval: "month" };
const PERIOD_END = new Date(Date.now() + 20 * 86_400_000).toISOString();

async function take(
  key: string,
  cents: number,
  change: Record<string, unknown> = BUSINESS,
  facts: Record<string, unknown> = {},
  periodEnd: string = PERIOD_END
) {
  const { data, error } = await admin.rpc("take_agent_budget", {
    p_user_id: userId,
    p_team_id: null,
    p_idempotency_key: key,
    p_cents: cents,
    p_key_id: null,
    p_agent_registration_id: null,
    p_change: change,
    p_description: "Change the plan.",
    p_subscription_id: SUB,
    p_target: change.kind === "seats" ? { seats: change.seats } : { productId: "prod_business" },
    p_period_end: periodEnd,
    p_facts: {
      chargeCents: cents,
      approximate: false,
      renewalCents: 2900,
      renewalRiseCents: 0,
      ...facts,
    },
  });
  if (error) throw error;
  return data as TakeResult;
}

/** A paid order for the plan's subscription, matched as the webhook matches it. */
function order(
  orderId: string,
  net: number,
  extra: { at?: string; productId?: string | null; seats?: number | null } = {}
) {
  return admin.rpc("raise_agent_budget_from_order", {
    p_subscription_id: SUB,
    p_order_id: orderId,
    p_net_cents: net,
    p_ordered_at: extra.at ?? new Date().toISOString(),
    p_product_id: extra.productId === undefined ? "prod_business" : extra.productId,
    p_seats: extra.seats ?? null,
  });
}

/** A retry's claim: what the spend counts at when this caller has it (null otherwise), and whether it may be sent. */
async function claimRetry(id: string, cents: number | null) {
  const { data, error } = await admin.rpc("claim_agent_budget_retry", { p_id: id, p_cents: cents });
  if (error) throw error;
  return data as { amount: number; resend: boolean } | null;
}

async function settle(id: string, status: string, outcome: Record<string, unknown> | null = null) {
  const { data, error } = await admin.rpc("settle_agent_budget_spend", {
    p_id: id,
    p_status: status,
    p_outcome: outcome,
  });
  if (error) throw error;
  return data as string;
}

async function spendRow(id: string) {
  const { data, error } = await admin
    .from("agent_budget_spends")
    .select("emailed_at, email_attempts, email_next_at, email_undeliverable")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

async function state() {
  const { data, error } = await admin.rpc("agent_budget_state", {
    p_user_id: userId,
    p_team_id: null,
  });
  if (error) throw error;
  return data as TakeResult;
}

describe("take_agent_budget", () => {
  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `test-abt-${ts}@webhooks-test.local`,
      password: "TestPassword123!",
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user!.id;
  });

  beforeEach(async () => {
    await admin.from("agent_budget_spends").delete().eq("user_id", userId);
    await admin.from("agent_budget_reductions").delete().eq("user_id", userId);
    await admin.from("approvals").delete().eq("user_id", userId);
    await admin.from("users").update({ agent_budget_cents: 5000 }).eq("id", userId);
  });

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it("takes no more than the budget when many changes race, one at a time", async () => {
    // Each finished spend leaves the account free for the next; ten at once
    // see each other through the row lock: one runs, the rest are busy.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => take(`h:race-${ts}-${i}`, 2000))
    );
    expect(results.filter((r) => r.status === "taken")).toHaveLength(1);
    expect(results.filter((r) => r.status === "busy")).toHaveLength(9);

    // Settled one by one, the budget allows two of 2000, never a third.
    const first = results.find((r) => r.status === "taken")!;
    await settle(first.id, "applied");
    const second = await take(`h:second-${ts}`, 2000);
    expect(second.status).toBe("taken");
    await settle(second.id, "applied");
    const third = await take(`h:third-${ts}`, 2000);
    expect(third).toMatchObject({ status: "over", left: 1000, needed: 2000 });
    expect(await state()).toMatchObject({ budget: 5000, spent: 4000, left: 1000 });
  });

  it("never takes twice for one key, however often it is sent", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => take(`h:same-${ts}`, 1500)));
    expect(results.filter((r) => r.status === "taken")).toHaveLength(1);
    expect(results.filter((r) => r.status === "existing")).toHaveLength(4);
    expect((await state()).spent).toBe(1500);
  });

  it("gives back only a running spend, and a given-back key takes a new spend", async () => {
    const taken = await take(`h:back-${ts}`, 3000);
    expect(await settle(taken.id, "returned")).toBe("returned");
    expect((await state()).spent).toBe(0);

    // The key never finds the spend given back: a new row, the old one kept.
    const again = await take(`h:back-${ts}`, 3000);
    expect(again.status).toBe("taken");
    expect(again.id).not.toBe(taken.id);
    const { data: rows } = await admin
      .from("agent_budget_spends")
      .select("id, status")
      .eq("user_id", userId)
      .eq("idempotency_key", `h:back-${ts}`);
    expect(rows).toHaveLength(2);
    expect(rows!.find((r) => r.id === taken.id)?.status).toBe("returned");
    expect(await settle(again.id, "applied")).toBe("applied");
    // Applied is final: a late give-back changes nothing.
    expect(await settle(again.id, "returned")).toBe("applied");
    expect((await state()).spent).toBe(3000);
  });

  it("refuses a key sent again with a different change, given back or not", async () => {
    const seats = { kind: "seats", seats: 5 };
    const taken = await take(`h:reuse-${ts}`, 1000);
    expect((await take(`h:reuse-${ts}`, 1000, seats)).status).toBe("key_reused");
    await settle(taken.id, "returned");
    expect((await take(`h:reuse-${ts}`, 1000, seats)).status).toBe("key_reused");
    // The same change under the same key is still its own retry.
    expect((await take(`h:reuse-${ts}`, 1000)).status).toBe("taken");
  });

  it("keeps an unsettled spend counted, and lets only one retry claim it", async () => {
    const taken = await take(`h:lost-${ts}`, 1000);
    expect(await settle(taken.id, "unsettled")).toBe("unsettled");
    expect((await state()).spent).toBe(1000);
    const claims = await Promise.all(Array.from({ length: 4 }, () => claimRetry(taken.id, null)));
    // The one that has it is answered with what the spend counts.
    expect(claims.filter((c) => c?.amount === 1000 && c.resend === false)).toHaveLength(1);
    expect(claims.filter((c) => c === null)).toHaveLength(3);
    // Another key is busy while it is unsettled or running.
    expect((await take(`h:other-${ts}`, 100)).status).toBe("busy");
  });

  it("counts a resend at no less than today's cost, never lower", async () => {
    const taken = await take(`h:resend-${ts}`, 1000);
    await settle(taken.id, "unsettled");
    expect(await claimRetry(taken.id, 1010)).toEqual({ amount: 1010, resend: true });
    expect((await state()).spent).toBe(1010);
    await settle(taken.id, "unsettled");
    expect(await claimRetry(taken.id, 900)).toEqual({ amount: 1010, resend: true });
    // Not sent again (p_cents null): what it counts stays.
    await settle(taken.id, "unsettled");
    expect(await claimRetry(taken.id, null)).toEqual({ amount: 1010, resend: false });
  });

  it("counts a spend until its counts_until, in every sum alike", async () => {
    const old = await take(`h:old-${ts}`, 4000);
    await settle(old.id, "applied");
    expect((await take(`h:new-${ts}`, 2000)).status).toBe("over");
    await admin
      .from("agent_budget_spends")
      .update({ counts_until: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", old.id);
    const fresh = await take(`h:new-${ts}`, 2000);
    expect(fresh.status).toBe("taken");
    const now = await state();
    expect(now.spent).toBe(2000);
    // The list comes from the same read: the old spend is listed, not counted.
    const listed = (now as unknown as { spends: Array<{ id: string; counted: boolean }> }).spends;
    expect(listed.find((spend) => spend.id === old.id)?.counted).toBe(false);
    expect(listed.find((spend) => spend.id === fresh.id)?.counted).toBe(true);
    // And the existing branch counts the others by the same rule.
    expect((await take(`h:new-${ts}`, 2000)).others).toBe(0);
  });

  it("counts a spend with a renewal rise until 30 days after that renewal", async () => {
    // A 31-day period: the renewal 31 days out, its rise charged then.
    const renewal = new Date(Date.now() + 31 * 86_400_000);
    const rise = await take(
      `h:rise-${ts}`,
      3000,
      BUSINESS,
      { renewalRiseCents: 2000, riseCounted: true },
      renewal.toISOString()
    );
    await settle(rise.id, "applied");
    // A renewal 45 days out (an annual plan near its end): its rise is not
    // counted on top, but the spend still counts until 30 days after it.
    const near = new Date(Date.now() + 45 * 86_400_000);
    const annual = await take(
      `h:near-${ts}`,
      0,
      { kind: "seats", seats: 8 },
      { riseCounted: false, annual: true },
      near.toISOString()
    );
    await settle(annual.id, "applied");
    // Further than 60 days: 30 days from now.
    const far = new Date(Date.now() + 90 * 86_400_000);
    const plain = await take(
      `h:plain-${ts}`,
      0,
      { kind: "seats", seats: 9 },
      { riseCounted: false, annual: true },
      far.toISOString()
    );
    const { data } = await admin
      .from("agent_budget_spends")
      .select("id, counts_until")
      .in("id", [rise.id, annual.id, plain.id]);
    const until = new Map((data ?? []).map((row) => [row.id, Date.parse(row.counts_until)]));
    const day = 86_400_000;
    expect(Math.abs(until.get(rise.id)! - (renewal.getTime() + 30 * day))).toBeLessThan(5_000);
    expect(Math.abs(until.get(annual.id)! - (near.getTime() + 30 * day))).toBeLessThan(5_000);
    expect(Math.abs(until.get(plain.id)! - (Date.now() + 30 * day))).toBeLessThan(5_000);
    // next_release is the first counts_until.
    expect(
      Date.parse(String(((await state()) as unknown as { next_release: string }).next_release))
    ).toBe(until.get(plain.id));
  });

  it("counts a charge the bank confirmed late from when it was paid", async () => {
    const taken = await take(`h:late-${ts}`, 1000);
    await settle(taken.id, "unsettled");
    await admin
      .from("agent_budget_spends")
      .update({ counts_until: new Date(Date.now() + 86_400_000).toISOString() })
      .eq("id", taken.id);
    const paid = new Date(Date.now() - 60_000);
    const pay = (paidAt: Date) =>
      admin.rpc("raise_agent_budget_from_order", {
        p_subscription_id: SUB,
        p_order_id: `ord_abt_late_${ts}`,
        p_net_cents: 1000,
        p_ordered_at: new Date().toISOString(),
        p_product_id: "prod_business",
        p_seats: null,
        p_paid_at: paidAt.toISOString(),
      });
    const until = async () => {
      const { data: row } = await admin
        .from("agent_budget_spends")
        .select("status, counts_until")
        .eq("id", taken.id)
        .single();
      return { status: row!.status, until: Date.parse(row!.counts_until) };
    };
    if ((await pay(paid)).error) throw new Error("order failed");
    const first = await until();
    expect(first.status).toBe("applied");
    expect(Math.abs(first.until - (paid.getTime() + 30 * 86_400_000))).toBeLessThan(5_000);
    // A paid time ahead of the database's clock is held to now.
    await pay(new Date(Date.now() + 5 * 86_400_000));
    expect((await until()).until).toBeLessThan(Date.now() + 31 * 86_400_000);
  });

  it("raises a spend to the order's before-tax amount when larger, never lower", async () => {
    const taken = await take(`h:order-${ts}`, 1000);
    await settle(taken.id, "applied");
    expect((await order(`ord_abt_${ts}`, 1200)).data).toMatchObject({ before: 1000, after: 1200 });
    expect((await order(`ord_abt_${ts}`, 900)).data).toMatchObject({ before: 1200, after: 1200 });
    expect((await state()).spent).toBe(1200);
  });

  it("adds the renewal's rise to the order's amount on a monthly plan, not on an annual one", async () => {
    // Counted at 1000 now plus 2400 the renewal rises: the order's 1200 plus that rise is more.
    const monthly = await take(`h:order-m-${ts}`, 3400, BUSINESS, {
      renewalRiseCents: 2400,
      riseCounted: true,
    });
    await settle(monthly.id, "applied");
    expect((await order(`ord_abt_m_${ts}`, 1200)).data).toMatchObject({
      before: 3400,
      after: 3600,
    });
    await admin.from("agent_budget_spends").delete().eq("user_id", userId);
    const annual = await take(`h:order-y-${ts}`, 3400, BUSINESS, {
      renewalRiseCents: 3400,
      annual: true,
      riseCounted: false,
    });
    await settle(annual.id, "applied");
    expect((await order(`ord_abt_y_${ts}`, 1200)).data).toMatchObject({
      before: 3400,
      after: 3400,
    });
    expect((await order(`ord_abt_y_${ts}`, 3500)).data).toMatchObject({ after: 3500 });
  });

  it("brings back a spend given back in the last day when an order for its target is paid", async () => {
    const back = await take(`h:order-back-${ts}`, 500);
    await settle(back.id, "returned");
    expect((await state()).spent).toBe(0);
    // The key took a new spend meanwhile: the old one moves to a key of its own.
    const again = await take(`h:order-back-${ts}`, 500);
    await settle(again.id, "returned");
    const revived = await order(`ord_abt_back_${ts}`, 1000);
    expect(revived.data).toMatchObject({ id: again.id, made: true, revived: true, after: 1000 });
    expect((await state()).spent).toBe(1000);
    const { data: row } = await admin
      .from("agent_budget_spends")
      .select("status, polar_order_id")
      .eq("id", again.id)
      .single();
    expect(row).toMatchObject({ status: "applied", polar_order_id: `ord_abt_back_${ts}` });

    // Given back more than a day ago, or for another target: never.
    await admin
      .from("agent_budget_spends")
      .update({ returned_at: new Date(Date.now() - 2 * 86_400_000).toISOString() })
      .eq("id", back.id);
    expect((await order(`ord_abt_back_old_${ts}`, 1000)).data).toBeNull();
    // An order made more than a minute after the give-back (the owner's own
    // change, say) never brings it back.
    const later = await take(`h:order-back-later-${ts}`, 500);
    await settle(later.id, "returned");
    await admin
      .from("agent_budget_spends")
      .update({ returned_at: new Date(Date.now() - 5 * 60_000).toISOString() })
      .eq("id", later.id);
    expect((await order(`ord_abt_back_later_${ts}`, 1000)).data).toBeNull();
    expect((await state()).spent).toBe(1000);
    const seats = await take(`h:order-back-seats-${ts}`, 500, { kind: "seats", seats: 6 });
    await settle(seats.id, "returned");
    expect(
      (await order(`ord_abt_back_seats_${ts}`, 700, { productId: null, seats: 7 })).data
    ).toBeNull();
  });

  it("brings back a declined card's give-back for 30 days, a plain refusal's for one", async () => {
    // Polar may collect a declined charge through its payment retries days
    // later: the order still dates from the try (within the minute).
    const declined = await take(`h:declined-back-${ts}`, 500);
    expect(await settle(declined.id, "returned", { code: "payment_failed" })).toBe("returned");
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await admin
      .from("agent_budget_spends")
      .update({ returned_at: twoDaysAgo.toISOString(), taken_at: twoDaysAgo.toISOString() })
      .eq("id", declined.id);
    const orderedAt = new Date(twoDaysAgo.getTime() + 30_000).toISOString();
    expect((await order(`ord_abt_declined_${ts}`, 500, { at: orderedAt })).data).toMatchObject({
      id: declined.id,
      made: true,
      revived: true,
    });
    expect((await state()).spent).toBe(500);

    const refused = await take(`h:refused-back-${ts}`, 500, { ...BUSINESS, n: 6 });
    expect(await settle(refused.id, "returned", { code: "seats_below_members" })).toBe("returned");
    await admin
      .from("agent_budget_spends")
      .update({ returned_at: twoDaysAgo.toISOString(), taken_at: twoDaysAgo.toISOString() })
      .eq("id", refused.id);
    expect((await order(`ord_abt_refused_${ts}`, 500, { at: orderedAt })).data).toBeNull();
    const { data: row } = await admin
      .from("agent_budget_spends")
      .select("status, outcome")
      .eq("id", refused.id)
      .single();
    expect(row).toMatchObject({ status: "returned", outcome: { code: "seats_below_members" } });
  });

  it("never gives back a spend once its outcome was not known, and makes one Polar showed", async () => {
    const lost = await take(`h:never-back-${ts}`, 800);
    expect(await settle(lost.id, "unsettled")).toBe("unsettled");
    // A retry claims it and its run gives it back: kept counted instead.
    expect(await claimRetry(lost.id, 800)).toEqual({ amount: 800, resend: true });
    expect(await settle(lost.id, "returned")).toBe("unsettled");
    expect((await state()).spent).toBe(800);
    // Settled, so the next take is not busy behind it.
    expect(await settle(lost.id, "applied")).toBe("applied");

    // Its order arrived while it ran: the run's lost answer settles it made.
    const ordered = await take(`h:ordered-${ts}`, 700, { kind: "seats", seats: 4 });
    await order(`ord_abt_ordered_${ts}`, 700, { productId: null, seats: 4 });
    expect(await settle(ordered.id, "unsettled")).toBe("applied");

    // A subscription event showed its target while it ran: the same.
    const seen = await take(`h:seen-${ts}`, 600, { kind: "seats", seats: 5 });
    const { data: settledNow } = await admin.rpc("settle_agent_budget_from_subscription", {
      p_subscription_id: SUB,
      p_seats: 5,
      p_product_id: "prod_team",
    });
    expect(settledNow).toEqual([]);
    expect(await settle(seen.id, "unsettled")).toBe("applied");
  });

  it("matches a subscription event or an order only to exactly the seats asked for", async () => {
    const asked = await take(`h:exact-${ts}`, 600, { kind: "seats", seats: 5 });
    await settle(asked.id, "unsettled");
    // More than 15 minutes on, the owner went on to 6 seats themselves: not
    // the agent's change.
    await admin
      .from("agent_budget_spends")
      .update({ unsettled_at: new Date(Date.now() - 20 * 60_000).toISOString() })
      .eq("id", asked.id);
    const { data: none } = await admin.rpc("settle_agent_budget_from_subscription", {
      p_subscription_id: SUB,
      p_seats: 6,
      p_product_id: "prod_team",
    });
    expect(none).toEqual([]);
    expect(
      (await order(`ord_abt_exact6_${ts}`, 600, { productId: null, seats: 6 })).data
    ).toBeNull();
    const { data: settled } = await admin.rpc("settle_agent_budget_from_subscription", {
      p_subscription_id: SUB,
      p_seats: 5,
      p_product_id: "prod_team",
    });
    expect(settled).toEqual([asked.id]);
  });

  it("makes an unsettled seat spend from more seats than it asked for, only within 15 minutes", async () => {
    const asked = await take(`h:more-${ts}`, 600, { kind: "seats", seats: 5 });
    // While it runs, more seats are not its target: only exactly 5 is.
    const { data: running } = await admin.rpc("settle_agent_budget_from_subscription", {
      p_subscription_id: SUB,
      p_seats: 6,
      p_product_id: "prod_team",
    });
    expect(running).toEqual([]);
    const { data: seen } = await admin
      .from("agent_budget_spends")
      .select("target_seen_at")
      .eq("id", asked.id)
      .single();
    expect(seen!.target_seen_at).toBeNull();
    // Unsettled, and the event comes within 15 minutes: the owner added a
    // seat on top of the agent's change, which was made.
    await settle(asked.id, "unsettled");
    const { data: settled } = await admin.rpc("settle_agent_budget_from_subscription", {
      p_subscription_id: SUB,
      p_seats: 6,
      p_product_id: "prod_team",
    });
    expect(settled).toEqual([asked.id]);
  });

  it("measures the 15 minutes for more seats from when the outcome was first not known", async () => {
    const asked = await take(`h:more-late-${ts}`, 600, { kind: "seats", seats: 5 });
    await settle(asked.id, "unsettled");
    // A fresh updated_at (a retry that looked, say) does not reopen it.
    await admin
      .from("agent_budget_spends")
      .update({
        unsettled_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", asked.id);
    const { data: more } = await admin.rpc("settle_agent_budget_from_subscription", {
      p_subscription_id: SUB,
      p_seats: 6,
      p_product_id: "prod_team",
    });
    expect(more).toEqual([]);
    // Exactly its seats still make it.
    const { data: exact } = await admin.rpc("settle_agent_budget_from_subscription", {
      p_subscription_id: SUB,
      p_seats: 5,
      p_product_id: "prod_team",
    });
    expect(exact).toEqual([asked.id]);
  });

  it("leaves when a made spend counts until alone when its order is delivered again", async () => {
    const made = await take(`h:redeliver-${ts}`, 1000);
    await order(`ord_abt_redeliver_${ts}`, 1000);
    await settle(made.id, "applied");
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    await admin.from("agent_budget_spends").update({ counts_until: soon }).eq("id", made.id);
    const again = await order(`ord_abt_redeliver_${ts}`, 1000);
    expect(again.data).toMatchObject({ id: made.id, made: false });
    const { data: row } = await admin
      .from("agent_budget_spends")
      .select("counts_until, amount_cents")
      .eq("id", made.id)
      .single();
    expect(Date.parse(row!.counts_until)).toBe(Date.parse(soon));
    expect(row!.amount_cents).toBe(1000);
  });

  it("sends the spent email for a spend an order made, even once its email was given up on", async () => {
    const lost = await take(`h:mail-revive-${ts}`, 700);
    await settle(lost.id, "unsettled");
    await admin.from("agent_budget_spends").update({ email_undeliverable: true }).eq("id", lost.id);
    const made = await order(`ord_abt_mail_revive_${ts}`, 700);
    expect(made.data).toMatchObject({ id: lost.id, made: true });
    expect((await spendRow(lost.id)).email_undeliverable).toBe(false);
    const { data: due } = await admin.rpc("pending_agent_budget_emails", { p_limit: 100 });
    expect(due as { spend_id: string; kind: string }[]).toContainEqual({
      spend_id: lost.id,
      kind: "spent",
    });
  });

  it("takes a spend under the id its caller chose, so a lost answer can find it", async () => {
    const id = crypto.randomUUID();
    const { data, error } = await admin.rpc("take_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_idempotency_key: `h:chosen-${ts}`,
      p_cents: 100,
      p_key_id: null,
      p_agent_registration_id: null,
      p_change: BUSINESS,
      p_description: "Change the plan.",
      p_subscription_id: SUB,
      p_target: { productId: "prod_business" },
      p_period_end: PERIOD_END,
      p_facts: {},
      p_id: id,
    });
    if (error) throw error;
    expect(data).toMatchObject({ status: "taken", id });
    expect(await settle(id, "returned")).toBe("returned");
  });

  it("matches only an order for the spend's target, made after it was taken", async () => {
    const live = await take(`h:order-target-${ts}`, 1000);
    await settle(live.id, "unsettled");
    // Another product, or an order from before the spend: not this spend's.
    expect(
      (await order(`ord_abt_other_${ts}`, 1500, { productId: "prod_pro_year" })).data
    ).toBeNull();
    expect(
      (
        await order(`ord_abt_early_${ts}`, 1500, {
          at: new Date(Date.now() - 10 * 60_000).toISOString(),
        })
      ).data
    ).toBeNull();
    // Its own order makes an unsettled spend, and says so once.
    const made = await order(`ord_abt_target_${ts}`, 1100);
    expect(made.data).toMatchObject({ id: live.id, before: 1000, after: 1100, made: true });
    const again = await order(`ord_abt_target_${ts}`, 1100);
    expect(again.data).toMatchObject({ made: false });
    const { data: row } = await admin
      .from("agent_budget_spends")
      .select("status")
      .eq("id", live.id)
      .single();
    expect(row!.status).toBe("applied");
  });

  it("matches a late order by when the spend last moved or was sent, not when it was first taken", async () => {
    const taken = await take(`h:order-late-${ts}`, 1000);
    // Taken an hour ago, sent again a moment ago (a retry): the order now is its.
    await admin
      .from("agent_budget_spends")
      .update({
        taken_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        status_changed_at: new Date().toISOString(),
        status: "unsettled",
      })
      .eq("id", taken.id);
    expect((await order(`ord_abt_late_${ts}`, 1000)).data).toMatchObject({ id: taken.id });
  });

  it("never matches an order by a fresh updated_at alone: only a status change or a send moves the window", async () => {
    const taken = await take(`h:order-look-${ts}`, 1000);
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    await admin
      .from("agent_budget_spends")
      .update({
        taken_at: old,
        status_changed_at: old,
        updated_at: new Date().toISOString(),
        status: "unsettled",
      })
      .eq("id", taken.id);
    expect((await order(`ord_abt_look_${ts}`, 1000)).data).toBeNull();
  });

  it("lets a retry that only looks hold the spend without moving any window, and the settle drops the hold", async () => {
    const taken = await take(`h:look-${ts}`, 1000);
    await settle(taken.id, "unsettled");
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    await admin
      .from("agent_budget_spends")
      .update({ updated_at: old, status_changed_at: old })
      .eq("id", taken.id);
    expect(await claimRetry(taken.id, null)).toEqual({ amount: 1000, resend: false });
    const { data: held } = await admin
      .from("agent_budget_spends")
      .select("status, updated_at, status_changed_at, retry_claimed_at, amount_cents")
      .eq("id", taken.id)
      .single();
    expect(held!.status).toBe("unsettled");
    expect(Date.parse(held!.updated_at)).toBe(Date.parse(old));
    expect(Date.parse(held!.status_changed_at)).toBe(Date.parse(old));
    expect(held!.retry_claimed_at).not.toBeNull();
    // One looker at a time, and no resend while it looks.
    expect(await claimRetry(taken.id, null)).toBeNull();
    expect(await claimRetry(taken.id, 1000)).toBeNull();
    // Kept unsettled: the hold goes, and the next retry may claim it.
    expect(await settle(taken.id, "unsettled")).toBe("unsettled");
    const { data: free } = await admin
      .from("agent_budget_spends")
      .select("retry_claimed_at, updated_at")
      .eq("id", taken.id)
      .single();
    expect(free!.retry_claimed_at).toBeNull();
    expect(Date.parse(free!.updated_at)).toBe(Date.parse(old));
    // A resend moves both, since it reaches Polar.
    expect(await claimRetry(taken.id, 1000)).toEqual({ amount: 1000, resend: true });
    const { data: resent } = await admin
      .from("agent_budget_spends")
      .select("status, status_changed_at")
      .eq("id", taken.id)
      .single();
    expect(resent!.status).toBe("running");
    expect(Date.parse(resent!.status_changed_at)).toBeGreaterThan(Date.parse(old));
  });

  it("clears a given-up email when a spend is made by its run or sent again", async () => {
    // Given up after its 30 tries at the 'unknown' email, put off for a day.
    const givenUp = {
      email_undeliverable: true,
      email_attempts: 30,
      email_next_at: new Date(Date.now() + 86_400_000).toISOString(),
    };
    // Its tries start again too, so the 'spent' email can be claimed now.
    const expectSendable = async (id: string) => {
      const row = await spendRow(id);
      expect(row.email_undeliverable).toBe(false);
      expect(row.email_attempts).toBe(0);
      expect(Date.parse(row.email_next_at)).toBeLessThanOrEqual(Date.now() + 5_000);
    };
    const made = await take(`h:undeliverable-made-${ts}`, 500);
    await settle(made.id, "unsettled");
    await admin.from("agent_budget_spends").update(givenUp).eq("id", made.id);
    expect(await settle(made.id, "applied")).toBe("applied");
    await expectSendable(made.id);
    expect(
      (await admin.rpc("claim_agent_budget_email", { p_id: made.id, p_kind: "spent" })).data
    ).toBe(true);

    const resent = await take(`h:undeliverable-resent-${ts}`, 500, { ...BUSINESS, n: 2 });
    await settle(resent.id, "unsettled");
    await admin.from("agent_budget_spends").update(givenUp).eq("id", resent.id);
    expect(await claimRetry(resent.id, 500)).toEqual({ amount: 500, resend: true });
    await expectSendable(resent.id);
    expect(await settle(resent.id, "applied")).toBe("applied");
    await expectSendable(resent.id);

    // Made by a subscription event, and by its paid order.
    const seen = await take(`h:undeliverable-seen-${ts}`, 500, { kind: "seats", seats: 9 });
    await settle(seen.id, "unsettled");
    await admin.from("agent_budget_spends").update(givenUp).eq("id", seen.id);
    const settled = await admin.rpc("settle_agent_budget_from_subscription", {
      p_subscription_id: SUB,
      p_seats: 9,
      p_product_id: "prod_team",
    });
    expect(settled.data).toContain(seen.id);
    await expectSendable(seen.id);

    const paid = await take(`h:undeliverable-paid-${ts}`, 500, { ...BUSINESS, n: 3 });
    await settle(paid.id, "unsettled");
    await admin.from("agent_budget_spends").update(givenUp).eq("id", paid.id);
    expect((await order(`ord_abt_undeliverable_${ts}`, 500)).data).toMatchObject({
      id: paid.id,
      made: true,
    });
    await expectSendable(paid.id);
    const { data: due } = await admin.rpc("pending_agent_budget_emails", { p_limit: 100 });
    expect(due as { spend_id: string; kind: string }[]).toContainEqual({
      spend_id: paid.id,
      kind: "spent",
    });
  });

  it("dates a retry's unknown outcome from when the spend last moved, not from the retry", async () => {
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    // A run that died: running, no word for 20 minutes, never unsettled.
    // Taken long enough ago that the next take is not refused as busy.
    const looked = await take(`h:unsettled-at-look-${ts}`, 300);
    await admin
      .from("agent_budget_spends")
      .update({ updated_at: old, taken_at: old })
      .eq("id", looked.id);
    expect(await claimRetry(looked.id, null)).toEqual({ amount: 300, resend: false });
    const resent = await take(`h:unsettled-at-resend-${ts}`, 300, { ...BUSINESS, n: 4 });
    await admin.from("agent_budget_spends").update({ updated_at: old }).eq("id", resent.id);
    expect(await claimRetry(resent.id, 300)).toEqual({ amount: 300, resend: true });
    const { data: rows } = await admin
      .from("agent_budget_spends")
      .select("id, unsettled_at")
      .in("id", [looked.id, resent.id]);
    for (const row of rows!) expect(Date.parse(row.unsettled_at!)).toBe(Date.parse(old));
    // One already unsettled keeps when it first was.
    const first = new Date(Date.now() - 40 * 60_000).toISOString();
    await admin
      .from("agent_budget_spends")
      .update({ status: "unsettled", unsettled_at: first, updated_at: old })
      .eq("id", resent.id);
    expect(await claimRetry(resent.id, 300)).toEqual({ amount: 300, resend: true });
    const { data: kept } = await admin
      .from("agent_budget_spends")
      .select("unsettled_at")
      .eq("id", resent.id)
      .single();
    expect(Date.parse(kept!.unsettled_at!)).toBe(Date.parse(first));
  });

  it("marks a lost take's id so a take arriving later takes nothing", async () => {
    const id = crypto.randomUUID();
    const buried = await admin.rpc("bury_lost_agent_budget_take", {
      p_id: id,
      p_user_id: userId,
      p_team_id: null,
    });
    expect(buried.error).toBeNull();
    expect(buried.data).toBeNull();
    // Sent again, the mark stays and says it was given back.
    expect(
      (
        await admin.rpc("bury_lost_agent_budget_take", {
          p_id: id,
          p_user_id: userId,
          p_team_id: null,
        })
      ).data
    ).toBe("returned");
    const late = await admin.rpc("take_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_idempotency_key: `h:late-${ts}`,
      p_cents: 1000,
      p_key_id: null,
      p_agent_registration_id: null,
      p_change: BUSINESS,
      p_description: "Change the plan.",
      p_subscription_id: SUB,
      p_target: { productId: "prod_business" },
      p_period_end: PERIOD_END,
      p_facts: {},
      p_id: id,
    });
    expect(late.error?.code).toBe("23505");
    const now = await state();
    expect(now.spent).toBe(0);
    expect((now as unknown as { spends: { id: string }[] }).spends).toEqual([]);
    const { data: due } = await admin.rpc("pending_agent_budget_emails", { p_limit: 100 });
    expect((due as { spend_id: string }[]).map((row) => row.spend_id)).not.toContain(id);
    // No order matches it, and the key is free for a take of its own.
    expect((await order(`ord_abt_lost_${ts}`, 1000)).data).toBeNull();
    const own = await take(`h:late-${ts}`, 1000);
    expect(own.status).toBe("taken");
    await settle(own.id, "returned");

    // A take that landed first: its status, for the caller to give back.
    const landed = crypto.randomUUID();
    await admin.rpc("take_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_idempotency_key: `h:landed-${ts}`,
      p_cents: 100,
      p_key_id: null,
      p_agent_registration_id: null,
      p_change: { ...BUSINESS, n: 5 },
      p_description: "Change the plan.",
      p_subscription_id: SUB,
      p_target: { productId: "prod_business" },
      p_period_end: PERIOD_END,
      p_facts: {},
      p_id: landed,
    });
    expect(
      (
        await admin.rpc("bury_lost_agent_budget_take", {
          p_id: landed,
          p_user_id: userId,
          p_team_id: null,
        })
      ).data
    ).toBe("running");
  });

  it("gives up on a spend email after 30 tries", async () => {
    const taken = await take(`h:mail-cap-${ts}`, 100);
    await settle(taken.id, "applied");
    await admin.from("agent_budget_spends").update({ email_attempts: 29 }).eq("id", taken.id);
    expect(
      (await admin.rpc("claim_agent_budget_email", { p_id: taken.id, p_kind: "spent" })).data
    ).toBe(true);
    await admin.rpc("finish_agent_budget_email", {
      p_id: taken.id,
      p_kind: "spent",
      p_result: "failed",
    });
    const row = await spendRow(taken.id);
    expect(row.email_attempts).toBe(30);
    expect(row.email_undeliverable).toBe(true);
    expect(
      (await admin.rpc("claim_agent_budget_email", { p_id: taken.id, p_kind: "spent" })).data
    ).toBe(false);
  });

  it("holds a reduction for the owner while a spend is unsettled or would read as one", async () => {
    const check = async (seats: number | null) => {
      const { data, error } = await admin.rpc("agent_budget_decrease_check", {
        p_user_id: userId,
        p_team_id: null,
        p_seats: seats,
      });
      if (error) throw error;
      return data as string | null;
    };
    expect(await check(2)).toBeNull();
    const asked = await take(`h:decrease-${ts}`, 600, { kind: "seats", seats: 5 });
    await settle(asked.id, "unsettled");
    // Its outcome is not known yet: every reduction waits.
    expect(await check(null)).toBe("busy");
    expect(await check(2)).toBe("busy");
    // Older than 15 minutes: only fewer seats at or above its target wait.
    await admin
      .from("agent_budget_spends")
      .update({ taken_at: new Date(Date.now() - 20 * 60_000).toISOString() })
      .eq("id", asked.id);
    expect(await check(null)).toBeNull();
    expect(await check(4)).toBeNull();
    expect(await check(5)).toBe("overlap");
    expect(await check(6)).toBe("overlap");
    // Made: nothing waits on it.
    await settle(asked.id, "applied");
    expect(await check(5)).toBeNull();
  });

  it("matches a seat order only when it reaches the target's seats", async () => {
    const { data, error } = await admin.rpc("take_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_idempotency_key: `h:order-seats-${ts}`,
      p_cents: 800,
      p_key_id: null,
      p_agent_registration_id: null,
      p_change: { kind: "seats", seats: 5 },
      p_description: "More seats.",
      p_subscription_id: SUB,
      p_target: { seats: 5 },
      p_period_end: PERIOD_END,
      p_facts: {},
    });
    if (error) throw error;
    const id = (data as TakeResult).id;
    expect((await order(`ord_abt_s4_${ts}`, 900, { productId: null, seats: 4 })).data).toBeNull();
    expect(
      (await order(`ord_abt_s5_${ts}`, 900, { productId: null, seats: 5 })).data
    ).toMatchObject({ id });
  });

  it("answers an existing spend with when it was taken, what it counts and the others", async () => {
    const other = await take(`h:exists-other-${ts}`, 700);
    await settle(other.id, "applied");
    const first = await take(`h:exists-${ts}`, 1200);
    await settle(first.id, "unsettled");
    const again = await take(`h:exists-${ts}`, 1200);
    expect(again).toMatchObject({
      status: "existing",
      id: first.id,
      quoted_cents: 1200,
      amount_cents: 1200,
      budget: 5000,
      others: 700,
    });
    expect(Date.parse(again.period_end!)).toBe(Date.parse(PERIOD_END));
    expect(again.age_seconds).toBeLessThan(60);
  });

  it("moves a derived key aside from an applied spend, never a header key", async () => {
    const derived = await take(`d:retire-${ts}`, 500);
    // Only an applied spend's key moves.
    expect((await admin.rpc("retire_agent_budget_key", { p_id: derived.id })).data).toBe(false);
    await settle(derived.id, "applied");
    const header = await take(`h:retire-${ts}`, 500);
    await settle(header.id, "applied");
    expect((await admin.rpc("retire_agent_budget_key", { p_id: header.id })).data).toBe(false);
    expect((await admin.rpc("retire_agent_budget_key", { p_id: derived.id })).data).toBe(true);
    // The key takes a new spend; the old one keeps counting.
    const fresh = await take(`d:retire-${ts}`, 500);
    expect(fresh.status).toBe("taken");
    expect((await state()).spent).toBe(1500);
  });

  it("lets one sender claim each spend email, and drops a claim whose send failed", async () => {
    const taken = await take(`h:mail-${ts}`, 500);
    const claim = (kind: string) =>
      admin.rpc("claim_agent_budget_email", { p_id: taken.id, p_kind: kind });
    const finish = (kind: string, result: string) =>
      admin.rpc("finish_agent_budget_email", { p_id: taken.id, p_kind: kind, p_result: result });
    const claims = await Promise.all(Array.from({ length: 4 }, () => claim("unknown")));
    expect(claims.filter((c) => c.data === true)).toHaveLength(1);
    // A failed send drops the claim and puts the next try off: nobody, the
    // request's own send included, claims it before its backoff is up.
    await finish("unknown", "failed");
    expect((await claim("unknown")).data).toBe(false);
    await admin
      .from("agent_budget_spends")
      .update({ email_next_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", taken.id);
    expect((await claim("unknown")).data).toBe(true);
    await finish("unknown", "sent");
    expect((await claim("unknown")).data).toBe(false);
    // Told it may have been made, the owner is still told once it was.
    expect((await claim("spent")).data).toBe(true);
    await finish("spent", "sent");
    const first = await spendRow(taken.id);
    expect(first.emailed_at).not.toBeNull();
    // Recording the send again (a retry after a lost answer) keeps the first time.
    await finish("spent", "sent");
    expect((await spendRow(taken.id)).emailed_at).toBe(first.emailed_at);
    expect((await claim("spent")).data).toBe(false);
  });

  it("puts a failed spend email off by a backoff, and takes an undeliverable one out of the queue", async () => {
    const pending = async () => {
      const { data, error } = await admin.rpc("pending_agent_budget_emails", { p_limit: 100 });
      if (error) throw error;
      return (data as { spend_id: string; kind: string }[]).map((row) => row.spend_id);
    };
    const failing = await take(`h:mail-fail-${ts}`, 100);
    await settle(failing.id, "applied");
    const nobody = await take(`h:mail-nobody-${ts}`, 100, { ...BUSINESS, n: 2 });
    await settle(nobody.id, "applied");
    expect(await pending()).toEqual(expect.arrayContaining([failing.id, nobody.id]));

    await admin.rpc("claim_agent_budget_email", { p_id: failing.id, p_kind: "spent" });
    await admin.rpc("finish_agent_budget_email", {
      p_id: failing.id,
      p_kind: "spent",
      p_result: "failed",
    });
    await admin.rpc("claim_agent_budget_email", { p_id: nobody.id, p_kind: "spent" });
    await admin.rpc("finish_agent_budget_email", {
      p_id: nobody.id,
      p_kind: "spent",
      p_result: "undeliverable",
    });
    const failed = await spendRow(failing.id);
    expect(failed.email_attempts).toBe(1);
    expect(Date.parse(failed.email_next_at)).toBeGreaterThan(Date.now() + 60_000);
    expect((await spendRow(nobody.id)).email_undeliverable).toBe(true);
    // Neither is due: the failed one waits its backoff, the undeliverable one is gone.
    const due = await pending();
    expect(due).not.toContain(failing.id);
    expect(due).not.toContain(nobody.id);
    expect(
      (await admin.rpc("claim_agent_budget_email", { p_id: nobody.id, p_kind: "spent" })).data
    ).toBe(false);

    // Once the backoff is past it is due again, oldest due first.
    await admin
      .from("agent_budget_spends")
      .update({ email_next_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", failing.id);
    const fresh = await take(`h:mail-fresh-${ts}`, 100, { ...BUSINESS, n: 3 });
    await settle(fresh.id, "applied");
    const order = await pending();
    expect(order.indexOf(failing.id)).toBeLessThan(order.indexOf(fresh.id));

    // A spend still unsent 7 days after its status last moved is given up
    // on, whatever updated_at says.
    await admin
      .from("agent_budget_spends")
      .update({
        status_changed_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", fresh.id);
    expect(await pending()).not.toContain(fresh.id);
    expect((await spendRow(fresh.id)).email_undeliverable).toBe(true);
  });

  it("sends at most one reduction notice an hour, with every reduction since the last", async () => {
    const record = (description: string) =>
      admin.rpc("record_agent_budget_reduction", {
        p_user_id: userId,
        p_team_id: null,
        p_key_id: null,
        p_description: description,
        p_renewal_cents: 2900,
      });
    const claim = async () => {
      const { data, error } = await admin.rpc("claim_agent_budget_reduction_notice", {
        p_user_id: userId,
        p_team_id: null,
      });
      if (error) throw error;
      return data as { status: string; claim?: string; reductions?: { description: string }[] };
    };
    const finish = (claimId: string, result: string) =>
      admin.rpc("finish_agent_budget_reduction_notice", { p_claim: claimId, p_result: result });
    const due = async () => {
      const { data } = await admin.rpc("pending_agent_budget_reduction_notices", { p_limit: 100 });
      return ((data ?? []) as { user_id: string | null }[]).some((row) => row.user_id === userId);
    };

    await record("First reduction.");
    await record("Second reduction.");
    // Two senders at once: one claims both, the other waits.
    const [a, b] = await Promise.all([claim(), claim()]);
    const won = a.status === "claimed" ? a : b;
    expect([a.status, b.status].sort()).toEqual(["claimed", "wait"]);
    expect(won.reductions!.map((r) => r.description)).toEqual([
      "First reduction.",
      "Second reduction.",
    ]);
    // A failed send drops the claim and backs off; the rows stay for the next
    // notice, which a request's own send waits for too.
    await finish(won.claim!, "failed");
    expect(await due()).toBe(false);
    expect((await claim()).status).toBe("wait");
    await admin
      .from("agent_budget_reductions")
      .update({ email_next_at: new Date(Date.now() - 1000).toISOString() })
      .eq("user_id", userId);
    expect(await due()).toBe(true);
    const again = await claim();
    expect(again.status).toBe("claimed");
    expect(again.reductions).toHaveLength(2);
    await finish(again.claim!, "sent");

    // Within the hour, a new reduction waits for the next notice.
    await record("Third reduction.");
    expect((await claim()).status).toBe("wait");
    expect(await due()).toBe(false);
    await admin
      .from("agent_budget_reductions")
      .update({ emailed_at: new Date(Date.now() - 61 * 60_000).toISOString() })
      .eq("user_id", userId)
      .not("emailed_at", "is", null);
    expect(await due()).toBe(true);
    const next = await claim();
    expect(next.reductions!.map((r) => r.description)).toEqual(["Third reduction."]);
    await finish(next.claim!, "sent");
    expect((await claim()).status).toBe("wait");
  });

  it("only looks at a resend the budget no longer covers, checked under the account's lock", async () => {
    const taken = await take(`h:resend-lowered-${ts}`, 1000);
    await settle(taken.id, "unsettled");
    // Another spend counts 3500 of the 5000; the owner lowers the budget to
    // 4000 after the request read it: 500 is left besides this spend.
    const other = await take(`h:resend-lowered-other-${ts}`, 100, { ...BUSINESS, n: 2 });
    expect(other.status).toBe("busy");
    await admin
      .from("agent_budget_spends")
      .update({ taken_at: new Date(Date.now() - 20 * 60_000).toISOString() })
      .eq("id", taken.id);
    const counted = await take(`h:resend-lowered-other-${ts}`, 3500, { ...BUSINESS, n: 2 });
    expect(counted.status).toBe("taken");
    await settle(counted.id, "applied");
    await admin.rpc("set_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_cents: 4000,
      p_only_lower: false,
    });
    expect(await claimRetry(taken.id, 1000)).toEqual({ amount: 1000, resend: false });
    const { data: row } = await admin
      .from("agent_budget_spends")
      .select("status, retry_claimed_at, amount_cents")
      .eq("id", taken.id)
      .single();
    expect(row).toMatchObject({ status: "unsettled", amount_cents: 1000 });
    expect(row!.retry_claimed_at).not.toBeNull();
    // Still covered (at most 500 now), it is sent.
    await settle(taken.id, "unsettled");
    expect(await claimRetry(taken.id, 500)).toEqual({ amount: 1000, resend: true });
  });

  it("gives each of two orders racing for one subscription a spend of its own", async () => {
    // Two spends with the same target, both unsettled; orders for both at
    // once must not both take the newest.
    for (let round = 0; round < 4; round++) {
      await admin.from("agent_budget_spends").delete().eq("user_id", userId);
      const first = await take(`h:order-race-a-${ts}-${round}`, 1000);
      await settle(first.id, "unsettled");
      await admin
        .from("agent_budget_spends")
        .update({ taken_at: new Date(Date.now() - 20 * 60_000).toISOString() })
        .eq("id", first.id);
      const second = await take(`h:order-race-b-${ts}-${round}`, 1000, { ...BUSINESS, n: 2 });
      expect(second.status).toBe("taken");
      await settle(second.id, "unsettled");
      const [a, b] = await Promise.all([
        order(`ord_abt_race_a_${ts}_${round}`, 1000),
        order(`ord_abt_race_b_${ts}_${round}`, 1000),
      ]);
      expect(a.error).toBeNull();
      expect(b.error).toBeNull();
      const ids = [a.data?.id, b.data?.id];
      expect(ids).not.toContain(undefined);
      expect(new Set(ids).size).toBe(2);
      const { data: rows } = await admin
        .from("agent_budget_spends")
        .select("id, polar_order_id, status")
        .in("id", [first.id, second.id]);
      expect(new Set(rows!.map((row) => row.polar_order_id)).size).toBe(2);
      for (const row of rows!) expect(row.status).toBe("applied");
    }
  });

  it("refuses a raise a two-factor reset finds running, so it never turns the budget back on", async () => {
    await admin.from("users").update({ agent_budget_cents: 0 }).eq("id", userId);
    const ask = async (status: string) => {
      const { data, error } = await admin
        .from("approvals")
        .insert({
          user_id: userId,
          action: "billing.agent_budget",
          params: { teamId: null, budgetCents: 5000, previousCents: 0 },
          summary: "Set the agent budget.",
          user_code: crypto.randomUUID().slice(0, 9),
          requester: "API key test",
          status,
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    };
    const setFor = (approvalId: string) =>
      admin.rpc("set_agent_budget", {
        p_user_id: userId,
        p_team_id: null,
        p_cents: 5000,
        p_only_lower: false,
        p_expected: 0,
        p_approval: approvalId,
      });
    // Decided and running (completed, no result yet), and approved.
    const running = await ask("completed");
    const approved = await ask("approved");
    const { error } = await admin.rpc("zero_agent_budgets_for_user", { p_user_id: userId });
    expect(error).toBeNull();
    const { data: rows } = await admin
      .from("approvals")
      .select("id, status, result")
      .in("id", [running, approved]);
    for (const row of rows!) {
      expect(row).toMatchObject({ status: "denied", result: { code: "budget_changed" } });
    }
    // The run that follows finds the budget it was asked against (0) but
    // its approval refused: nothing is set.
    expect((await setFor(running)).data).toMatchObject({ status: "changed", previous: 0 });
    expect((await state()).budget).toBe(0);
    // A raise whose approval still stands is set.
    const standing = await ask("completed");
    expect((await setFor(standing)).data).toMatchObject({ status: "ok", budget: 5000 });
  });

  it("refuses every pending raise of the budget when the budget changes", async () => {
    const ask = (budgetCents: number, teamId: string | null = null) =>
      admin
        .from("approvals")
        .insert({
          user_id: userId,
          action: "billing.agent_budget",
          params: { teamId, budgetCents },
          summary: "Set the agent budget.",
          user_code: crypto.randomUUID().slice(0, 9),
          requester: "API key test",
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        })
        .select("id")
        .single();
    const raise = await ask(9000);
    const other = await ask(8000, "00000000-0000-4000-8000-000000000001");
    if (raise.error) throw raise.error;
    if (other.error) throw other.error;
    const status = async (id: string) => {
      const { data } = await admin.from("approvals").select("status").eq("id", id).single();
      return data!.status;
    };
    // Setting the same budget leaves it waiting.
    await admin.rpc("set_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_cents: 5000,
      p_only_lower: false,
    });
    expect(await status(raise.data.id)).toBe("pending");
    // A lower budget, by a key or a session, refuses it by its status, so
    // no clock can let it be approved after.
    await admin.rpc("set_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_cents: 3000,
      p_only_lower: true,
    });
    expect(await status(raise.data.id)).toBe("denied");
    // It says why, for the asker's poll.
    const { data: refused } = await admin
      .from("approvals")
      .select("result")
      .eq("id", raise.data.id)
      .single();
    expect(refused!.result).toEqual({ code: "budget_changed" });
    const { data: decided } = await admin.rpc("decide_approval", {
      p_id: raise.data.id,
      p_from: "pending",
      p_status: "completed",
      p_ttl_seconds: 600,
    });
    expect(decided).toBe(false);
    // A team's raise is the team's: lowering the personal budget leaves it.
    expect(await status(other.data.id)).toBe("pending");
    // A raise set by a session refuses the rest too: each was asked against the old budget.
    const third = await ask(9500);
    if (third.error) throw third.error;
    await admin.rpc("set_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_cents: 4000,
      p_only_lower: false,
    });
    expect(await status(third.data.id)).toBe("denied");
  });

  it("sets an approved raise only from the budget it was asked against", async () => {
    const { data: changed } = await admin.rpc("set_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_cents: 9000,
      p_only_lower: false,
      p_expected: 7000,
    });
    expect(changed).toMatchObject({ status: "changed", previous: 5000 });
    const { data: row } = await admin
      .from("users")
      .select("agent_budget_cents")
      .eq("id", userId)
      .single();
    expect(row!.agent_budget_cents).toBe(5000);
    const { data: set } = await admin.rpc("set_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_cents: 9000,
      p_only_lower: false,
      p_expected: 5000,
    });
    expect(set).toMatchObject({ status: "ok", previous: 5000, budget: 9000 });
  });

  it("decides an approval only while it is pending and unexpired by the database's clock", async () => {
    const insert = (expiresAt: string) =>
      admin
        .from("approvals")
        .insert({
          user_id: userId,
          action: "billing.agent_budget",
          params: { teamId: null, budgetCents: 9000 },
          summary: "Set the agent budget.",
          user_code: crypto.randomUUID().slice(0, 9),
          requester: "API key test",
          expires_at: expiresAt,
        })
        .select("id")
        .single();
    const gone = await insert(new Date(Date.now() - 1000).toISOString());
    if (gone.error) throw gone.error;
    const decide = (id: string, from = "pending") =>
      admin.rpc("decide_approval", {
        p_id: id,
        p_from: from,
        p_status: "completed",
        p_ttl_seconds: 600,
      });
    expect((await decide(gone.data.id)).data).toBe(false);
    const live = await insert(new Date(Date.now() + 600_000).toISOString());
    if (live.error) throw live.error;
    expect((await decide(live.data.id, "approved")).data).toBe(false);
    expect((await decide(live.data.id)).data).toBe(true);
    expect((await decide(live.data.id)).data).toBe(false);
  });

  it("refuses a pending raise when the key that asked is revoked", async () => {
    const { data: key, error: keyError } = await admin
      .from("api_keys")
      .insert({
        user_id: userId,
        name: "raise asker",
        key_hash: `hash-${crypto.randomUUID()}`,
        key_prefix: "whcc_test",
      })
      .select("id")
      .single();
    if (keyError) throw keyError;
    const { data: approval, error } = await admin
      .from("approvals")
      .insert({
        user_id: userId,
        action: "billing.agent_budget",
        params: { teamId: null, budgetCents: 9000 },
        summary: "Set the agent budget.",
        user_code: crypto.randomUUID().slice(0, 9),
        requester: "API key test",
        requested_by_key: key.id,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    await admin.from("api_keys").delete().eq("id", key.id);
    const { data: row } = await admin
      .from("approvals")
      .select("status, result")
      .eq("id", approval.id)
      .single();
    // Refused with a result, as a changed budget's raises are.
    expect(row).toEqual({ status: "denied", result: { code: "asker_revoked" } });
  });

  it("is off at 0, and set_agent_budget refuses a raise asked to only lower", async () => {
    await admin.from("users").update({ agent_budget_cents: 0 }).eq("id", userId);
    expect((await take(`h:off-${ts}`, 0)).status).toBe("off");
    const { data: refused } = await admin.rpc("set_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_cents: 100,
      p_only_lower: true,
    });
    expect(refused).toMatchObject({ status: "raise_needs_owner", previous: 0 });
    const { error } = await admin.rpc("set_agent_budget", {
      p_user_id: userId,
      p_team_id: null,
      p_cents: 50_001,
      p_only_lower: false,
    });
    expect(error).not.toBeNull();
  });
});
