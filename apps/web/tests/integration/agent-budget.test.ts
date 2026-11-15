import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

// Polar is faked: a team subscription the routes read and change, so
// nothing reaches Polar (sandbox included) and nothing is charged. The dev
// mail transport records mail instead of sending it.
const fake = vi.hoisted(() => ({
  subs: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<{ id: string; body: Record<string, unknown> }>,
  /** What the next update does: answer, refuse with a 402, ask for 3-D Secure, or time out. */
  next: "ok" as "ok" | "decline" | "action" | "timeout_after_apply" | "timeout_before_apply",
  /** Runs once, on the next subscription read. */
  onGet: null as null | (() => Promise<void>),
  auth: null as null | { userId: string; keyId?: string; agentRegistrationId?: string | null },
  /** How many of the next emails fail to send. */
  failMail: 0,
}));

vi.mock("@/lib/email/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/mailer")>();
  return {
    ...actual,
    sendEmail: async (message: Parameters<typeof actual.sendEmail>[0]) => {
      if (fake.failMail > 0) {
        fake.failMail--;
        throw new Error("SMTP is down");
      }
      return actual.sendEmail(message);
    },
  };
});

vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  const { PolarNetworkError } = await import("@polar-sh/sdk");
  const { errors } = await import("@polar-sh/sdk/2026-10");
  // Through the real mutation guard, as the real client goes inside a
  // change on the budget: each update renews the lease in the database first.
  const { guardPolarClient } = await import("@/lib/billing/polar-guard");
  return {
    ...actual,
    createPolarClient: () =>
      guardPolarClient({
        subscriptions: {
          get: async (id: string) => {
            if (fake.onGet) {
              const run = fake.onGet;
              fake.onGet = null;
              await run();
            }
            const sub = fake.subs.get(id);
            if (!sub) throw new Error(`no fake subscription ${id}`);
            return { ...sub };
          },
          update: async (id: string, body: Record<string, unknown>) => {
            fake.updates.push({ id, body });
            const mode = fake.next;
            fake.next = "ok";
            if (mode === "decline") {
              throw new errors.SubscriptionsUpdate402Error(402, {
                error: "PaymentFailed",
                detail: "Payment failed with reason: card_error.",
              } as never);
            }
            if (mode === "action") {
              throw new errors.SubscriptionsUpdate402Error(402, {
                error: "PaymentActionRequired",
                detail: "The payment needs the cardholder to confirm it.",
              } as never);
            }
            if (mode === "timeout_before_apply") throw new PolarNetworkError("Request timed out");
            const sub = fake.subs.get(id)!;
            if (typeof body.seats === "number" && body.proration_behavior === "invoice") {
              sub.amount = ((sub.amount as number) / (sub.seats as number)) * body.seats;
              sub.seats = body.seats;
            }
            if (typeof body.seats === "number" && body.proration_behavior === "next_period") {
              sub.pending_update = { seats: body.seats };
            }
            if (mode === "timeout_after_apply") throw new PolarNetworkError("Request timed out");
            return { ...sub };
          },
        },
        orders: {
          iterList: async function* () {
            // No orders: no account credit.
          },
        },
      }),
  };
});

vi.mock("@/lib/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-auth")>();
  return {
    ...actual,
    authenticateRequestRequireUser: async () =>
      fake.auth
        ? { success: true, ...fake.auth }
        : { success: false, response: Response.json({ error: "no" }, { status: 401 }) },
  };
});

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, checkRateLimit: async () => null };
});

import { POST as postSeats } from "@/app/api/teams/[teamId]/billing/seats/route";
import {
  GET as getTeamBudget,
  PUT as putTeamBudget,
} from "@/app/api/teams/[teamId]/billing/agent-budget/route";
import { GET as getBudget, PUT as putBudget } from "@/app/api/billing/agent-budget/route";
import { decideApproval, reviewApproval } from "@/lib/approvals/store";
import {
  sendPendingAgentBudgetEmails,
  settleAgentBudgetFromWebhook,
} from "@/lib/billing/agent-budget";
import { getLastMessageForEmail, __resetEmailTestStore } from "@/lib/email/dev-transport";
import { removeTwoFactor } from "@/lib/mfa-recovery";
import { generateApiKey, hashApiKey } from "@/lib/supabase/api-keys";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
const SUB = `sub_ab_${ts}`;
let owner: string;
let member: string;
let ownerKey: string;
let memberKey: string;
let teamId: string;

function email(label: string) {
  return `test-ab-${label}-${ts}@webhooks-test.local`;
}

async function makeUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: email(label),
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!.id;
}

async function makeKey(userId: string, name: string): Promise<string> {
  const raw = generateApiKey();
  const { data, error } = await admin
    .from("api_keys")
    .insert({ user_id: userId, name, key_hash: hashApiKey(raw), key_prefix: raw.slice(0, 12) })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

function resetSubscription() {
  const start = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const end = new Date(Date.now() + 20 * 86_400_000).toISOString();
  fake.subs.set(SUB, {
    id: SUB,
    status: "active",
    customer_id: `cus_ab_${ts}`,
    product_id: "prod_team",
    seats: 3,
    amount: 3600,
    currency: "usd",
    cancel_at_period_end: false,
    current_period_start: start,
    current_period_end: end,
    pending_update: null,
  });
}

function req(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request("https://webhooks.cc/api/x", {
    method,
    headers: { "content-type": "application/json", "user-agent": "whk 1.20.0", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A route's JSON answer, read loosely as the tests check it. */
interface Answer {
  executed?: boolean | null;
  applied?: string;
  viaBudget?: boolean;
  chargedCents: number;
  countedCents: number;
  renewalRiseCents: number;
  renewalCents?: number;
  replayed?: boolean;
  ownerEmail?: string;
  code?: string;
  approval: { id: string; action: string; summary: string; code: string };
  budget: { reason: string; leftCents: number; neededCents: number };
}

const params = () => ({ params: Promise.resolve({ teamId }) });

async function seats(n: number, headers: Record<string, string> = {}) {
  const response = await postSeats(req("POST", { seats: n }, headers), params());
  return { status: response.status, body: (await response.json()) as Answer };
}

async function setBudget(cents: number) {
  await admin.from("teams").update({ agent_budget_cents: cents }).eq("id", teamId);
}

async function spends() {
  const { data } = await admin
    .from("agent_budget_spends")
    .select("*")
    .eq("team_id", teamId)
    .order("taken_at", { ascending: true });
  return data ?? [];
}

describe("agent spend budget", () => {
  beforeAll(async () => {
    owner = await makeUser("owner");
    member = await makeUser("member");
    ownerKey = await makeKey(owner, "deploy bot");
    memberKey = await makeKey(member, "member bot");
    const { data, error } = await admin.rpc("create_team_with_owner", {
      p_user_id: owner,
      p_name: "Acme budget",
    });
    if (error) throw error;
    teamId = (data as { id: string }).id;
    const { error: teamError } = await admin
      .from("teams")
      .update({
        polar_customer_id: `cus_ab_${ts}`,
        polar_subscription_id: SUB,
        subscription_status: "active",
        seats: 3,
        period_start: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        period_end: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      })
      .eq("id", teamId);
    if (teamError) throw teamError;
    await admin.from("team_members").insert({ team_id: teamId, user_id: member, role: "member" });
  });

  beforeEach(async () => {
    resetSubscription();
    fake.updates = [];
    fake.next = "ok";
    fake.onGet = null;
    fake.failMail = 0;
    fake.auth = { userId: owner, keyId: ownerKey };
    __resetEmailTestStore();
    await admin.from("agent_budget_spends").delete().eq("team_id", teamId);
    await admin.from("agent_budget_reductions").delete().eq("team_id", teamId);
    await admin
      .from("teams")
      .update({ seats: 3, pending_seats: null, subscription_status: "active" })
      .eq("id", teamId);
    await setBudget(10_000);
  });

  afterAll(async () => {
    if (teamId) await admin.from("teams").delete().eq("id", teamId);
    for (const id of [owner, member]) if (id) await admin.auth.admin.deleteUser(id);
  });

  it("adds seats on the budget with no approval, counts the quote, and emails the owner", async () => {
    const result = await seats(5);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ executed: true, applied: "now", viaBudget: true });
    expect(result.body.chargedCents).toBeGreaterThan(1500);
    expect(result.body.renewalCents).toBe(6000);
    // Two more seats at $12 charge about $16 for the 20 days left and raise
    // the next renewal by $24, which falls inside the 30 days too: the
    // budget counts both.
    expect(result.body.renewalRiseCents).toBe(2400);
    expect(result.body.chargedCents).toBeLessThan(2400);
    const counted = result.body.chargedCents + 2400;
    expect(result.body.countedCents).toBe(counted);
    expect(result.body.ownerEmail).toBe("sent");
    expect(fake.updates).toEqual([{ id: SUB, body: { seats: 5, proration_behavior: "invoice" } }]);

    const rows = await spends();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "applied",
      key_id: ownerKey,
      amount_cents: counted,
      quoted_cents: counted,
    });
    expect(rows[0].emailed_at).not.toBeNull();
    expect(result.body.budget.leftCents).toBe(10_000 - counted);

    const mail = getLastMessageForEmail(email("owner"));
    expect(mail?.kind).toBe("agent_budget_spent");
    expect(mail?.text).toContain("deploy bot");
    expect(mail?.text).toContain("from 3 to 5 seats");
    expect(mail?.text).toContain("renews at $60.00, $24.00 more than before");
    expect(mail?.text).toContain(
      `Counted against the agent budget: $${(counted / 100).toFixed(2)}, the charge now plus the rise of the next renewal`
    );
    expect(mail?.text).toContain(`/teams/${teamId}`);

    const { data: audit } = await admin
      .from("audit_events")
      .select("action")
      .eq("team_id", teamId)
      .in("action", ["billing.agent_budget_spent", "team.seats_changed"]);
    expect(new Set((audit ?? []).map((a) => a.action))).toEqual(
      new Set(["billing.agent_budget_spent", "team.seats_changed"])
    );

    // The same request again (same derived key) is the same spend: the
    // seats it changed moved the key on, so it reaches the usual path.
    const again = await seats(5, { "idempotency-key": "seats-to-five-0001" });
    expect(again.status).not.toBe(200);
    expect(fake.updates).toHaveLength(1);
  });

  it("falls back to the owner's approval with what is left and what is needed", async () => {
    await setBudget(500);
    const result = await seats(5);
    expect(result.status).toBe(202);
    expect(result.body.approval.action).toBe("billing.change");
    expect(result.body.budget).toMatchObject({
      used: false,
      reason: "over_budget",
      leftCents: 500,
    });
    expect(result.body.budget.neededCents).toBeGreaterThan(500);
    expect(fake.updates).toEqual([]);
    expect(await spends()).toEqual([]);
  });

  it("refuses to the approval when the charge plus the renewal's rise is more than is left, though each fits", async () => {
    // About $16 now and $24 more at the renewal: each fits in $30, both do not.
    await setBudget(3000);
    const result = await seats(5);
    expect(result.status).toBe(202);
    expect(result.body.approval.action).toBe("billing.change");
    expect(result.body.budget).toMatchObject({ reason: "over_budget", leftCents: 3000 });
    expect(result.body.budget.neededCents).toBeGreaterThan(2400 + 1500);
    expect(result.body.budget.neededCents).toBeLessThan(2400 + 1700);
    expect(fake.updates).toEqual([]);
    expect(await spends()).toEqual([]);
  });

  it("is off at 0, and a key cannot raise it without the owner", async () => {
    await setBudget(0);
    const result = await seats(5);
    expect(result.status).toBe(202);
    expect(result.body.budget.reason).toBe("budget_off");

    const raised = await putTeamBudget(req("PUT", { budgetCents: 20_000 }), params());
    expect(raised.status).toBe(202);
    const approval = ((await raised.json()) as Answer).approval;
    expect(approval.action).toBe("billing.agent_budget");
    expect(approval.summary).toContain("$200.00");
    let { data: team } = await admin
      .from("teams")
      .select("agent_budget_cents")
      .eq("id", teamId)
      .single();
    expect(team!.agent_budget_cents).toBe(0);
    expect(approval.summary).not.toContain("now");

    // What the budget is now is read when the page renders, not when asked.
    await setBudget(1500);
    const review = await reviewApproval(approval.code, owner, null);
    expect(review?.details.find((d) => d.label === "Now")?.value).toBe("$15.00");
    // Approved against a budget that is no longer what it was asked
    // against: refused for good, and the budget stays as it is. The
    // asker's poll says the budget changed, so it asks again.
    await expect(decideApproval(approval.code, owner, true)).rejects.toThrow(/changed since/);
    ({ data: team } = await admin
      .from("teams")
      .select("agent_budget_cents")
      .eq("id", teamId)
      .single());
    expect(team!.agent_budget_cents).toBe(1500);
    const { data: refused } = await admin
      .from("approvals")
      .select("status, result")
      .eq("id", approval.id)
      .single();
    expect(refused).toEqual({ status: "denied", result: { code: "budget_changed" } });
    // Approving it again cannot run it: it was refused.
    await expect(decideApproval(approval.code, owner, true)).rejects.toThrow(/already answered/);

    await setBudget(0);
    const again = await putTeamBudget(req("PUT", { budgetCents: 20_000 }), params());
    const asked = ((await again.json()) as Answer).approval;
    const decided = await decideApproval(asked.code, owner, true);
    expect(decided.done).toBe(true);
    ({ data: team } = await admin
      .from("teams")
      .select("agent_budget_cents")
      .eq("id", teamId)
      .single());
    expect(team!.agent_budget_cents).toBe(20_000);
    const mail = getLastMessageForEmail(email("owner"));
    expect(mail?.kind).toBe("agent_budget_set");
    expect(mail?.text).toContain("deploy bot");
  });

  it("refuses a raise waiting for approval once the budget is lowered, by a key or a session", async () => {
    for (const byKey of [true, false]) {
      await setBudget(5000);
      fake.auth = { userId: owner, keyId: ownerKey };
      const raised = await putTeamBudget(req("PUT", { budgetCents: 20_000 }), params());
      expect(raised.status).toBe(202);
      const approval = ((await raised.json()) as Answer).approval;
      fake.auth = byKey ? { userId: owner, keyId: ownerKey } : { userId: owner };
      const lowered = await putTeamBudget(req("PUT", { budgetCents: 1000 }), params());
      expect(lowered.status).toBe(200);
      // The raise asked for before can no longer be given.
      await expect(decideApproval(approval.code, owner, true)).rejects.toThrow(/expired/);
      const { data: team } = await admin
        .from("teams")
        .select("agent_budget_cents")
        .eq("id", teamId)
        .single();
      expect(team!.agent_budget_cents).toBe(1000);
    }
  });

  it("lets a key lower the budget at once, and a session set it", async () => {
    const lowered = await putTeamBudget(req("PUT", { budgetCents: 2500 }), params());
    expect(lowered.status).toBe(200);
    expect(await lowered.json()).toMatchObject({ budgetCents: 2500, previousCents: 10_000 });

    fake.auth = { userId: owner };
    const set = await putTeamBudget(req("PUT", { budgetCents: 40_000 }), params());
    expect(set.status).toBe(200);
    expect(getLastMessageForEmail(email("owner"))?.kind).toBe("agent_budget_set");
    const tooMuch = await putTeamBudget(req("PUT", { budgetCents: 50_001 }), params());
    expect(tooMuch.status).toBe(400);

    const read = await getTeamBudget(req("GET"), params());
    expect(await read.json()).toMatchObject({ budgetCents: 40_000, maxCents: 50_000 });
  });

  it("is the team owner's alone: a member's key reads and spends nothing", async () => {
    fake.auth = { userId: member, keyId: memberKey };
    expect((await getTeamBudget(req("GET"), params())).status).toBe(403);
    expect((await putTeamBudget(req("PUT", { budgetCents: 0 }), params())).status).toBe(403);
    const result = await seats(5);
    expect(result.status).toBe(403);
    expect(fake.updates).toEqual([]);
    expect(await spends()).toEqual([]);
  });

  it("stops while the team's payment is past due", async () => {
    await admin.from("teams").update({ subscription_status: "past_due" }).eq("id", teamId);
    const result = await seats(5);
    expect(result.status).toBe(202);
    expect(result.body.budget.reason).toBe("past_due");
    expect(fake.updates).toEqual([]);
  });

  it("waits for an approved change holding the account's lease: one change at a time", async () => {
    const key = `team:${teamId}`;
    const { data: claimed } = await admin.rpc("claim_billing_change_lock", {
      p_account_key: key,
      p_holder: crypto.randomUUID(),
      p_seconds: 60,
    });
    expect(claimed).toBe(true);
    try {
      const result = await seats(5);
      expect(result.status).toBe(202);
      expect(result.body.approval.action).toBe("billing.change");
      expect(result.body.budget.reason).toBe("change_running");
      expect(fake.updates).toEqual([]);
      expect(await spends()).toEqual([]);
    } finally {
      await admin.from("billing_change_locks").delete().eq("account_key", key);
    }
    // Free again: the spend runs, and its own lease is released after.
    expect((await seats(5)).status).toBe(200);
    const { count } = await admin
      .from("billing_change_locks")
      .select("account_key", { count: "exact", head: true })
      .eq("account_key", key);
    expect(count).toBe(0);
  });

  it("gives the spend back at once when the lease is lost before Polar is asked", async () => {
    const key = `team:${teamId}`;
    // While the change is quoted under its lease, another run takes it over.
    fake.onGet = async () => {
      const { error } = await admin
        .from("billing_change_locks")
        .update({
          holder: crypto.randomUUID(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        })
        .eq("account_key", key);
      if (error) throw error;
    };
    try {
      const result = await seats(5);
      expect(result.status).toBe(503);
      expect(fake.updates).toEqual([]);
      const rows = await spends();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("returned");
    } finally {
      await admin.from("billing_change_locks").delete().eq("account_key", key);
    }
    const read = await getTeamBudget(req("GET"), params());
    expect(await read.json()).toMatchObject({ spentCents: 0, leftCents: 10_000 });
  });

  it("refuses an Idempotency-Key sent again with a different change", async () => {
    const first = await seats(5, { "idempotency-key": "seats-reused-key-01" });
    expect(first.status).toBe(200);
    await admin.from("teams").update({ seats: 5 }).eq("id", teamId);
    const reused = await seats(6, { "idempotency-key": "seats-reused-key-01" });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("idempotency_key_reused");
    expect(fake.updates).toHaveLength(1);
    expect(await spends()).toHaveLength(1);
  });

  it("stops while another spend's outcome is not known yet", async () => {
    const { error } = await admin.rpc("take_agent_budget", {
      p_user_id: null,
      p_team_id: teamId,
      p_idempotency_key: "h:another-change-0001",
      p_cents: 100,
      p_key_id: ownerKey,
      p_agent_registration_id: null,
      p_change: { kind: "seats", seats: 9 },
      p_description: "Another change.",
      p_subscription_id: SUB,
      p_target: { seats: 9 },
      p_period_end: null,
      p_facts: {},
    });
    if (error) throw error;
    const result = await seats(5);
    expect(result.status).toBe(202);
    expect(result.body.budget.reason).toBe("change_running");
  });

  it("gives back a change Polar refused (a declined card)", async () => {
    fake.next = "decline";
    const result = await seats(5);
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({ code: "payment_failed" });
    const rows = await spends();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "returned", outcome: { code: "payment_failed" } });
    const read = await getTeamBudget(req("GET"), params());
    expect(await read.json()).toMatchObject({ spentCents: 0, leftCents: 10_000 });
    expect(getLastMessageForEmail(email("owner"))).toBeNull();
  });

  it("keeps a 3-D Secure charge counted as an unknown outcome, and never sends it again", async () => {
    fake.next = "action";
    const first = await seats(5, { "idempotency-key": "seats-five-3ds-0001" });
    expect(first.status).toBe(502);
    expect(first.body).toMatchObject({ code: "outcome_unknown", executed: null });
    let rows = await spends();
    expect(rows[0].status).toBe("unsettled");

    const again = await seats(5, { "idempotency-key": "seats-five-3ds-0001" });
    expect(again.status).toBe(502);
    expect(again.body.code).toBe("outcome_unknown");
    expect(fake.updates).toHaveLength(1);
    rows = await spends();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unsettled");
    const read = await getTeamBudget(req("GET"), params());
    expect(((await read.json()) as Record<string, number>).spentCents).toBe(rows[0].amount_cents);
  });

  it("keeps a timed-out change taken, and a retry finds it made without sending it again", async () => {
    fake.next = "timeout_after_apply";
    const first = await seats(5, { "idempotency-key": "seats-five-retry-01" });
    expect(first.status).toBe(502);
    expect(first.body).toMatchObject({ code: "outcome_unknown", executed: null });
    let rows = await spends();
    expect(rows[0].status).toBe("unsettled");
    const read = await getTeamBudget(req("GET"), params());
    expect(((await read.json()) as Record<string, number>).spentCents).toBe(rows[0].amount_cents);

    const retry = await seats(5, { "idempotency-key": "seats-five-retry-01" });
    expect(retry.status).toBe(200);
    expect(retry.body.executed).toBe(true);
    // Polar showed 5 seats already: no second update.
    expect(fake.updates).toHaveLength(1);
    rows = await spends();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("applied");
  });

  it("sends a change again after a timeout that never reached Polar, on the same spend", async () => {
    fake.next = "timeout_before_apply";
    const first = await seats(5, { "idempotency-key": "seats-five-retry-02" });
    expect(first.status).toBe(502);
    const [before] = await spends();
    const retry = await seats(5, { "idempotency-key": "seats-five-retry-02" });
    expect(retry.status).toBe(200);
    expect(fake.updates).toHaveLength(2);
    const rows = await spends();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("applied");
    // Counted at no less than the first count or today's quote, and answered from the row.
    expect(rows[0].amount_cents).toBeGreaterThanOrEqual(before.amount_cents);
    expect(retry.body.countedCents).toBe(rows[0].amount_cents);
  });

  it("settles an unsettled spend from the subscription webhook, and counts the larger invoice", async () => {
    fake.next = "timeout_after_apply";
    await seats(5, { "idempotency-key": "seats-five-webhook-1" });
    let [row] = await spends();
    expect(row.status).toBe("unsettled");
    // The owner hears at once that the card may have been charged.
    expect(getLastMessageForEmail(email("owner"))?.kind).toBe("agent_budget_unknown");
    expect(getLastMessageForEmail(email("owner"))?.text).toContain("may have been charged");

    await settleAgentBudgetFromWebhook("subscription.updated", {
      id: SUB,
      seats: 5,
      product_id: "prod_team",
    });
    [row] = await spends();
    expect(row.status).toBe("applied");
    // Made after all: the spend email the request never sent goes now, once.
    expect(getLastMessageForEmail(email("owner"))?.kind).toBe("agent_budget_spent");
    expect(row.emailed_at).not.toBeNull();

    const paidOrder = (eventType: string, net: number, extra: Record<string, unknown> = {}) =>
      settleAgentBudgetFromWebhook(eventType, {
        id: `ord_ab_${ts}`,
        status: "paid",
        subscription_id: SUB,
        product_id: "prod_team",
        seats: 5,
        billing_reason: "subscription_update",
        net_amount: net,
        created_at: new Date().toISOString(),
        ...extra,
      });
    // The invoice charged $2.50 more than the quote: counted at it plus
    // the renewal's rise, which the order does not carry.
    const counted = row.amount_cents;
    const invoice = counted - 2400 + 250;
    // Only a paid order counts: created, updated or not yet paid ones never do.
    await paidOrder("order.created", invoice);
    await paidOrder("order.updated", invoice);
    await paidOrder("order.paid", invoice, { status: "pending" });
    [row] = await spends();
    expect(row.amount_cents).toBe(counted);
    // Nor one for fewer seats than the spend's target, or with no seats at all.
    await paidOrder("order.paid", invoice, { seats: 4 });
    await paidOrder("order.paid", invoice, { seats: null });
    [row] = await spends();
    expect(row.amount_cents).toBe(counted);

    // An order without seats of its own is matched by its subscription's.
    await paidOrder("order.paid", invoice, { seats: null, subscription: { id: SUB, seats: 5 } });
    [row] = await spends();
    expect(row.amount_cents).toBe(counted + 250);
    // A smaller amount for the same order never lowers it.
    await paidOrder("order.paid", 10);
    [row] = await spends();
    expect(row.amount_cents).toBe(counted + 250);
  });

  it("does not send a change again once its spend is too old, its period moved or the budget fell", async () => {
    const cases: Array<[string, () => Promise<void>]> = [
      [
        "seats-five-old-0001",
        async () => {
          const [row] = await spends();
          await admin
            .from("agent_budget_spends")
            .update({ taken_at: new Date(Date.now() - 20 * 60_000).toISOString() })
            .eq("id", row.id);
        },
      ],
      [
        "seats-five-period-01",
        async () => {
          fake.subs.get(SUB)!.current_period_end = new Date(
            Date.now() + 21 * 86_400_000
          ).toISOString();
        },
      ],
      ["seats-five-budget-01", () => setBudget(2000)],
    ];
    for (const [key, change] of cases) {
      resetSubscription();
      await setBudget(10_000);
      await admin.from("agent_budget_spends").delete().eq("team_id", teamId);
      fake.updates = [];
      __resetEmailTestStore();
      fake.next = "timeout_before_apply";
      const first = await seats(5, { "idempotency-key": key });
      expect(first.status).toBe(502);
      expect(getLastMessageForEmail(email("owner"))?.kind).toBe("agent_budget_unknown");
      const [taken] = await spends();
      await change();
      const retry = await seats(5, { "idempotency-key": key });
      expect(retry.status, key).toBe(502);
      expect(retry.body.code).toBe("outcome_unknown");
      // Never sent a second time; still counted, still not known.
      expect(fake.updates, key).toHaveLength(1);
      const rows = await spends();
      expect(rows).toHaveLength(1);
      // Not sent again, so not counted at today's quote either.
      expect(rows[0]).toMatchObject({ status: "unsettled", amount_cents: taken.amount_cents });
    }
  });

  it("replays a derived key's applied spend only while Polar shows it, else takes a new one", async () => {
    const first = await seats(5);
    expect(first.status).toBe(200);
    // Our row still says 3 seats (the webhook is late) while Polar shows 5:
    // the same request is answered again, and nothing is sent.
    await admin.from("teams").update({ seats: 3, pending_seats: null }).eq("id", teamId);
    const replay = await seats(5);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(fake.updates).toHaveLength(1);

    // The owner took the seats back out: Polar shows 3 again, so the same
    // request is a new change, with a spend of its own.
    resetSubscription();
    const again = await seats(5);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBeUndefined();
    expect(fake.updates).toHaveLength(2);
    const rows = await spends();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "applied")).toBe(true);
  });

  it("answers the same Idempotency-Key again after a webhook made its change, not with a 409", async () => {
    fake.next = "timeout_after_apply";
    const first = await seats(5, { "idempotency-key": "seats-five-replay-01" });
    expect(first.status).toBe(502);
    await settleAgentBudgetFromWebhook("subscription.updated", {
      id: SUB,
      seats: 5,
      product_id: "prod_team",
    });
    // The plan's own handling of the event moved the team's seats too.
    await admin.from("teams").update({ seats: 5 }).eq("id", teamId);
    const again = await seats(5, { "idempotency-key": "seats-five-replay-01" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      replayed: true,
      executed: true,
      viaBudget: true,
      idempotencyKey: "seats-five-replay-01",
    });
    expect(fake.updates).toHaveLength(1);
    expect(await spends()).toHaveLength(1);
  });

  it("asks the owner for fewer seats while a plan change waits for the renewal", async () => {
    await admin
      .from("teams")
      .update({ seats: 4, pending_plan: "team", pending_interval: "month" })
      .eq("id", teamId);
    fake.subs.get(SUB)!.seats = 4;
    fake.subs.get(SUB)!.amount = 4800;
    try {
      const fewer = await seats(3);
      expect(fewer.status).toBe(202);
      expect(fewer.body.approval.action).toBe("billing.change");
      expect(fake.updates).toHaveLength(0);
      // Polar's own pending product counts as a waiting plan change too.
      await admin
        .from("teams")
        .update({ pending_plan: null, pending_interval: null })
        .eq("id", teamId);
      fake.subs.get(SUB)!.pending_update = { product_id: "prod_team", seats: null };
      const again = await seats(3);
      expect(again.status).toBe(202);
      expect(fake.updates).toHaveLength(0);
    } finally {
      await admin
        .from("teams")
        .update({ pending_plan: null, pending_interval: null })
        .eq("id", teamId);
      // Not left waiting: the account's pending approvals are capped.
      await admin
        .from("approvals")
        .delete()
        .eq("user_id", owner)
        .eq("action", "billing.change")
        .eq("status", "pending");
    }
  });

  it("runs fewer seats directly while the budget is on, and asks the owner while it is off", async () => {
    await admin.from("teams").update({ seats: 4 }).eq("id", teamId);
    fake.subs.get(SUB)!.seats = 4;
    fake.subs.get(SUB)!.amount = 4800;
    const direct = await seats(3);
    expect(direct.status).toBe(200);
    expect(direct.body).toMatchObject({ executed: true, applied: "renewal", chargedCents: 0 });
    expect(await spends()).toEqual([]);
    expect(direct.body.ownerEmail).toBe("sent");
    const notice = getLastMessageForEmail(email("owner"));
    expect(notice?.kind).toBe("agent_budget_decrease");
    expect(notice?.text).toContain("deploy bot");

    // A second reduction within the hour waits for the next notice.
    await admin.from("teams").update({ seats: 4, pending_seats: null }).eq("id", teamId);
    fake.subs.get(SUB)!.pending_update = null;
    __resetEmailTestStore();
    const second = await seats(3);
    expect(second.status).toBe(200);
    expect(second.body.ownerEmail).toBe("queued");
    expect(getLastMessageForEmail(email("owner"))).toBeNull();
    await sendPendingAgentBudgetEmails();
    expect(getLastMessageForEmail(email("owner"))).toBeNull();
    // Once the hour is up the poller sends it; a failed send is tried again later.
    await admin
      .from("agent_budget_reductions")
      .update({ emailed_at: new Date(Date.now() - 61 * 60_000).toISOString() })
      .eq("team_id", teamId)
      .not("emailed_at", "is", null);
    fake.failMail = 1;
    expect((await sendPendingAgentBudgetEmails()).failed).toBeGreaterThanOrEqual(1);
    expect(getLastMessageForEmail(email("owner"))).toBeNull();
    await admin
      .from("agent_budget_reductions")
      .update({ email_next_at: new Date(Date.now() - 1000).toISOString() })
      .eq("team_id", teamId)
      .is("emailed_at", null);
    await sendPendingAgentBudgetEmails();
    const later = getLastMessageForEmail(email("owner"));
    expect(later?.kind).toBe("agent_budget_decrease");
    expect(later?.text).toContain("from 4 to 3 seats");
    const { data: reductions } = await admin
      .from("agent_budget_reductions")
      .select("emailed_at")
      .eq("team_id", teamId);
    expect(reductions?.every((r) => r.emailed_at !== null)).toBe(true);

    // A budget with nothing left authorises no reduction either.
    await admin.from("teams").update({ seats: 4, pending_seats: null }).eq("id", teamId);
    fake.subs.get(SUB)!.pending_update = null;
    await admin.from("agent_budget_spends").insert({
      team_id: teamId,
      idempotency_key: "h:spent-it-all-0001",
      change: { kind: "seats", seats: 9 },
      description: "An earlier change.",
      quoted_cents: 10_000,
      amount_cents: 10_000,
      status: "applied",
      taken_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const exhausted = await seats(3);
    expect(exhausted.status).toBe(202);
    expect(exhausted.body.budget).toMatchObject({ reason: "over_budget", leftCents: 0 });
    await admin.from("agent_budget_spends").delete().eq("team_id", teamId);

    await admin.from("teams").update({ seats: 4, pending_seats: null }).eq("id", teamId);
    await setBudget(0);
    const asked = await seats(3);
    expect(asked.status).toBe(202);
    expect(asked.body.budget.reason).toBe("budget_off");
  });

  it("asks the owner for a reduction while a spend's outcome is not known, or would read as it", async () => {
    await admin.from("teams").update({ seats: 6 }).eq("id", teamId);
    fake.subs.get(SUB)!.seats = 6;
    fake.subs.get(SUB)!.amount = 7200;
    const unsettled = async (takenAgoMinutes: number) => {
      await admin.from("agent_budget_spends").delete().eq("team_id", teamId);
      const { error } = await admin.from("agent_budget_spends").insert({
        team_id: teamId,
        idempotency_key: `h:unsettled-${takenAgoMinutes}`,
        change: { kind: "seats", seats: 5 },
        description: "Change the team from 4 to 5 seats.",
        quoted_cents: 600,
        amount_cents: 600,
        status: "unsettled",
        polar_subscription_id: SUB,
        target: { seats: 5 },
        unsettled_at: new Date(Date.now() - takenAgoMinutes * 60_000).toISOString(),
        taken_at: new Date(Date.now() - takenAgoMinutes * 60_000).toISOString(),
      });
      if (error) throw error;
    };

    // Unsettled in the last 15 minutes: no reduction runs on the budget.
    await unsettled(1);
    const busy = await seats(3);
    expect(busy.status).toBe(202);
    expect(busy.body.budget.reason).toBe("change_running");

    // Older: a reduction to at or above its 5 seats would read as it made.
    await unsettled(20);
    const overlap = await seats(5);
    expect(overlap.status).toBe(202);
    expect(overlap.body.budget).toMatchObject({ reason: "change_running" });
    expect(overlap.body.budget).toHaveProperty(
      "message",
      expect.stringContaining("tell the two apart")
    );
    // Below its target it runs as usual.
    const below = await seats(4);
    expect(below.status).toBe(200);
    expect(below.body).toMatchObject({ executed: true, chargedCents: 0 });
    expect(fake.updates).toHaveLength(1);
  });

  it("turns the budget off when the team's ownership changes", async () => {
    await admin
      .from("team_members")
      .update({ role: "owner" })
      .eq("team_id", teamId)
      .eq("user_id", member);
    const { data: team } = await admin
      .from("teams")
      .select("agent_budget_cents")
      .eq("id", teamId)
      .single();
    expect(team!.agent_budget_cents).toBe(0);
    await admin
      .from("team_members")
      .update({ role: "member" })
      .eq("team_id", teamId)
      .eq("user_id", member);
  });

  it("turns every budget the person controls off when two-factor is removed", async () => {
    await admin.from("users").update({ agent_budget_cents: 3000 }).eq("id", owner);
    // A team the person created whose owner membership is gone (as account
    // deletion finds teams, by created_by), with a budget.
    const { data: made, error: madeError } = await admin.rpc("create_team_with_owner", {
      p_user_id: owner,
      p_name: "Acme created",
    });
    if (madeError) throw madeError;
    const created = (made as { id: string }).id;
    await admin.from("team_members").delete().eq("team_id", created).eq("user_id", owner);
    await admin.from("teams").update({ agent_budget_cents: 4000 }).eq("id", created);
    // A raise still waiting for the owner's approval.
    const asked = await putBudget(req("PUT", { budgetCents: 9000 }));
    expect(asked.status).toBe(202);
    const pending = ((await asked.json()) as Answer).approval;

    try {
      await removeTwoFactor(owner, "support");
      const [{ data: user }, { data: team }, { data: createdTeam }] = await Promise.all([
        admin.from("users").select("agent_budget_cents").eq("id", owner).single(),
        admin.from("teams").select("agent_budget_cents").eq("id", teamId).single(),
        admin.from("teams").select("agent_budget_cents").eq("id", created).single(),
      ]);
      expect(user!.agent_budget_cents).toBe(0);
      expect(team!.agent_budget_cents).toBe(0);
      expect(createdTeam!.agent_budget_cents).toBe(0);
      const { data: approval } = await admin
        .from("approvals")
        .select("status")
        .eq("user_code", pending.code)
        .single();
      expect(approval!.status).toBe("denied");
    } finally {
      await admin.from("teams").delete().eq("id", created);
    }
    const { data: audit } = await admin
      .from("audit_events")
      .select("action, metadata")
      .eq("team_id", teamId)
      .eq("action", "billing.agent_budget_zeroed");
    expect(audit?.some((a) => (a.metadata as { reason?: string }).reason === "support")).toBe(true);
  });

  it("reads and sets the personal budget too", async () => {
    fake.auth = { userId: owner };
    const set = await putBudget(req("PUT", { budgetCents: 1234 }));
    expect(set.status).toBe(200);
    const read = await getBudget(req("GET"));
    expect(await read.json()).toMatchObject({ budgetCents: 1234, spentCents: 0, windowDays: 30 });
  });
});
