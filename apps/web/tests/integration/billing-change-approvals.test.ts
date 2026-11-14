import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

// Polar is faked: a subscription the routes read and change, so nothing
// reaches Polar (sandbox included) and nothing is charged.
const fake = vi.hoisted(() => ({
  subs: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<{ id: string; body: Record<string, unknown> }>,
  checkouts: [] as Array<Record<string, unknown>>,
  // The next update fails like a timeout after Polar applied it.
  failNextUpdate: false,
  // The next read fails like Polar being unreachable.
  failNextGet: false,
}));

vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  return {
    ...actual,
    createPolarClient: () => ({
      subscriptions: {
        get: async (id: string) => {
          if (fake.failNextGet) {
            fake.failNextGet = false;
            throw new Error("connect ECONNREFUSED");
          }
          const sub = fake.subs.get(id);
          if (!sub) throw new Error(`no fake subscription ${id}`);
          return { ...sub };
        },
        update: async (id: string, body: Record<string, unknown>) => {
          fake.updates.push({ id, body });
          const sub = fake.subs.get(id)!;
          if (typeof body.seats === "number" && body.proration_behavior === "invoice") {
            sub.amount = ((sub.amount as number) / (sub.seats as number)) * body.seats;
            sub.seats = body.seats;
          }
          if (typeof body.cancel_at_period_end === "boolean") {
            sub.cancel_at_period_end = body.cancel_at_period_end;
          }
          if (fake.failNextUpdate) {
            fake.failNextUpdate = false;
            throw new Error("socket hang up");
          }
          return { ...sub };
        },
      },
      checkouts: {
        create: async (body: Record<string, unknown>) => {
          fake.checkouts.push(body);
          return {
            id: `chk_${fake.checkouts.length}`,
            url: `https://polar.test/checkout/${fake.checkouts.length}`,
          };
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

import { requestApproval } from "@/lib/approvals/request";
import { decideApproval, pollApproval, type ApprovalView } from "@/lib/approvals/store";
import type { BillingQuote } from "@/lib/billing/change";
import { generateApiKey, hashApiKey } from "@/lib/supabase/api-keys";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
const SUB = `sub_bca_${ts}`;
const PERSONAL_SUB = `sub_bca_personal_${ts}`;
let owner: string;
let member: string;
let ownerKey: string;
let memberKey: string;
let teamId: string;

async function makeUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-bca-${label}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!.id;
}

async function makeKey(userId: string): Promise<string> {
  const raw = generateApiKey();
  const { data, error } = await admin
    .from("api_keys")
    .insert({
      user_id: userId,
      name: "agent",
      key_hash: hashApiKey(raw),
      key_prefix: raw.slice(0, 12),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

function periodNow() {
  const start = new Date(Date.now() - 10 * 86_400_000);
  const end = new Date(Date.now() + 20 * 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function resetTeamSubscription() {
  const { start, end } = periodNow();
  fake.subs.set(SUB, {
    id: SUB,
    status: "active",
    customer_id: `cus_bca_${ts}`,
    product_id: "prod_team",
    seats: 3,
    amount: 3600,
    cancel_at_period_end: false,
    current_period_start: start,
    current_period_end: end,
    pending_update: null,
  });
}

async function ask(userId: string, keyId: string, body: Record<string, unknown>) {
  const response = await requestApproval(
    new Request("https://webhooks.cc/api/billing", {
      method: "POST",
      headers: { "user-agent": "whk 1.20.0 on linux" },
    }),
    { userId, keyId },
    "billing.change",
    body
  );
  return {
    status: response.status,
    body: (await response.json()) as { approval: ApprovalView; error?: string },
  };
}

async function approve(userId: string, code: string) {
  return decideApproval(code, userId, true);
}

describe("billing changes an agent asks for", () => {
  beforeAll(async () => {
    owner = await makeUser("owner");
    member = await makeUser("member");
    ownerKey = await makeKey(owner);
    memberKey = await makeKey(member);
    const { data, error } = await admin.rpc("create_team_with_owner", {
      p_user_id: owner,
      p_name: "Acme agents",
    });
    if (error) throw error;
    teamId = (data as { id: string }).id;
    const { start, end } = periodNow();
    const { error: teamError } = await admin
      .from("teams")
      .update({
        polar_customer_id: `cus_bca_${ts}`,
        polar_subscription_id: SUB,
        subscription_status: "active",
        seats: 3,
        period_start: start,
        period_end: end,
      })
      .eq("id", teamId);
    if (teamError) throw teamError;
    const { error: memberError } = await admin
      .from("team_members")
      .insert({ team_id: teamId, user_id: member, role: "member" });
    if (memberError) throw memberError;
    const { error: userError } = await admin
      .from("users")
      .update({
        plan: "pro",
        polar_customer_id: `cus_bca_personal_${ts}`,
        polar_subscription_id: PERSONAL_SUB,
        subscription_status: "active",
        cancel_at_period_end: false,
      })
      .eq("id", owner);
    if (userError) throw userError;
  });

  beforeEach(() => {
    resetTeamSubscription();
    fake.updates = [];
    fake.checkouts = [];
    fake.failNextUpdate = false;
    fake.failNextGet = false;
  });

  afterAll(async () => {
    if (teamId) await admin.from("teams").delete().eq("id", teamId);
    for (const id of [owner, member]) if (id) await admin.auth.admin.deleteUser(id);
  });

  it("quotes added seats, runs them once on approval, and a replay changes nothing", async () => {
    const asked = await ask(owner, ownerKey, { teamId, change: { kind: "seats", seats: 5 } });
    expect(asked.status).toBe(202);
    const approval = asked.body.approval;
    expect(approval.action).toBe("billing.change");
    expect(approval.summary).toContain("from 3 to 5 seats");
    // The asker names the team; the sentence never carries the name.
    expect(approval.summary).not.toContain("Acme agents");
    expect(approval.summary).toMatch(/\$\d+\.\d\d is charged now/);

    const { data: row } = await admin
      .from("approvals")
      .select("params")
      .eq("id", approval.id)
      .single();
    const quote = (row!.params as { quote: BillingQuote }).quote;
    // 2 seats at $12 for about two thirds of the period.
    expect(quote.dueNowCents).toBeGreaterThan(1500);
    expect(quote.dueNowCents).toBeLessThan(1700);
    expect(quote.renewalCents).toBe(6000);

    const decided = await approve(owner, approval.code);
    expect(decided.done).toBe(true);
    expect(decided.result).toMatchObject({ executed: true, applied: "now" });
    expect(fake.updates).toEqual([{ id: SUB, body: { seats: 5, proration_behavior: "invoice" } }]);
    const { data: team } = await admin.from("teams").select("seats").eq("id", teamId).single();
    expect(team!.seats).toBe(5);

    // Approving again finds nothing pending.
    await expect(approve(owner, approval.code)).rejects.toThrow(/already answered/);

    // The asker reads the outcome.
    const polled = await pollApproval(approval.id, { userId: owner, keyId: ownerKey });
    expect(polled?.approval.status).toBe("completed");
    expect(polled?.result).toMatchObject({ executed: true });

    // Running the same approved quote again (a retried run) refuses: the
    // seats it changed are part of what it was quoted from.
    const { runBillingChange } = await import("@/lib/billing/change");
    const again = await runBillingChange(
      owner,
      { teamId, change: { kind: "seats", seats: 5 } },
      quote
    );
    expect(again.outcome.executed).toBe(false);
    expect(fake.updates).toHaveLength(1);

    await admin.from("teams").update({ seats: 3 }).eq("id", teamId);
  });

  it("changes nothing when the price moved between the ask and the approval", async () => {
    const asked = await ask(owner, ownerKey, { teamId, change: { kind: "seats", seats: 4 } });
    expect(asked.status).toBe(202);
    fake.subs.get(SUB)!.amount = 4500;

    const decided = await approve(owner, asked.body.approval.code);
    expect(decided.result).toMatchObject({ executed: false, code: "quote_changed" });
    expect(fake.updates).toEqual([]);
    const { data: team } = await admin.from("teams").select("seats").eq("id", teamId).single();
    expect(team!.seats).toBe(3);

    const polled = await pollApproval(asked.body.approval.id, { userId: owner, keyId: ownerKey });
    expect(polled?.result).toMatchObject({ executed: false });
  });

  it("refuses a member's key and a change the team does not allow", async () => {
    const byMember = await ask(member, memberKey, { teamId, change: { kind: "seats", seats: 4 } });
    expect(byMember.status).toBe(403);
    const unchanged = await ask(owner, ownerKey, { teamId, change: { kind: "seats", seats: 3 } });
    expect(unchanged.status).toBe(409);
    const unknown = await ask(owner, ownerKey, { teamId, change: { kind: "refund" } });
    expect(unknown.status).toBe(400);
    expect(fake.updates).toEqual([]);
  });

  it("records an unknown outcome when Polar fails after being asked, for both sides", async () => {
    const asked = await ask(owner, ownerKey, { teamId, change: { kind: "seats", seats: 4 } });
    expect(asked.status).toBe(202);
    fake.failNextUpdate = true;
    const decided = await approve(owner, asked.body.approval.code);
    expect(decided.result).toMatchObject({ executed: null, code: "outcome_unknown" });
    const polled = await pollApproval(asked.body.approval.id, { userId: owner, keyId: ownerKey });
    expect(polled?.approval.status).toBe("completed");
    expect(polled?.result).toMatchObject({ executed: null, code: "outcome_unknown" });
    expect(String(polled?.result?.reason)).toMatch(/Check billing/);
    // Never back to pending: approving again could charge twice.
    await expect(approve(owner, asked.body.approval.code)).rejects.toThrow(/already answered/);
  });

  it("gives the approval back when billing cannot be read for the fresh quote", async () => {
    const asked = await ask(owner, ownerKey, { teamId, change: { kind: "seats", seats: 4 } });
    expect(asked.status).toBe(202);
    fake.failNextGet = true;
    await expect(approve(owner, asked.body.approval.code)).rejects.toMatchObject({ status: 503 });
    const { data: row } = await admin
      .from("approvals")
      .select("status")
      .eq("id", asked.body.approval.id)
      .single();
    expect(row!.status).toBe("pending");
    expect(fake.updates).toEqual([]);
    // Approved again once Polar answers, it runs.
    const decided = await approve(owner, asked.body.approval.code);
    expect(decided.result).toMatchObject({ executed: true });
    await admin.from("teams").update({ seats: 3 }).eq("id", teamId);
  });

  it("two approvals for one team approved together never both run", async () => {
    const a = await ask(owner, ownerKey, { teamId, change: { kind: "seats", seats: 4 } });
    const b = await ask(owner, ownerKey, { teamId, change: { kind: "seats", seats: 5 } });
    const results = await Promise.allSettled([
      approve(owner, a.body.approval.code),
      approve(owner, b.body.approval.code),
    ]);
    const ran = results.filter(
      (r) =>
        r.status === "fulfilled" && (r.value.result as { executed?: unknown }).executed === true
    );
    expect(ran).toHaveLength(1);
    expect(fake.updates).toHaveLength(1);
    const { count } = await admin
      .from("billing_change_locks")
      .select("account_key", { count: "exact", head: true })
      .eq("account_key", `team:${teamId}`);
    expect(count).toBe(0);
    await admin.from("teams").update({ seats: 3 }).eq("id", teamId);
  });

  it("opens a checkout pinned to the approved count, and only the owner's browser gets it", async () => {
    vi.stubEnv("POLAR_REQUEST_BLOCKS_PRODUCT_ID", "prod_bca_one_time");
    vi.stubEnv("POLAR_MONTHLY_BLOCKS_PRODUCT_ID", "prod_bca_monthly");
    vi.stubEnv("POLAR_MONTHLY_BLOCKS_ADD_PRODUCT_ID", "prod_bca_monthly_add");
    vi.stubEnv("POLAR_OVERAGE_PRODUCT_ID", "prod_bca_overage");
    try {
      const asked = await ask(owner, ownerKey, {
        teamId,
        change: { kind: "capacity", capacity: { action: "buy_blocks", blocks: 3 } },
      });
      expect(asked.status).toBe(202);
      expect(asked.body.approval.summary).toContain("for the team");
      const decided = await approve(owner, asked.body.approval.code);
      expect(decided.forBrowser).toEqual({ checkoutUrl: "https://polar.test/checkout/1" });
      expect(decided.result).toMatchObject({
        executed: true,
        applied: "checkout",
        checkout: "opened",
      });
      expect(fake.checkouts[0]).toMatchObject({ units: 3, min_units: 3, max_units: 3 });
      const polled = await pollApproval(asked.body.approval.id, { userId: owner, keyId: ownerKey });
      expect(JSON.stringify(polled)).not.toContain("polar.test");
      const { data: row } = await admin
        .from("approvals")
        .select("result")
        .eq("id", asked.body.approval.id)
        .single();
      expect(JSON.stringify(row!.result)).not.toContain("polar.test");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("cancels the account's own plan at the period end once approved", async () => {
    const { start, end } = periodNow();
    fake.subs.set(PERSONAL_SUB, {
      id: PERSONAL_SUB,
      status: "active",
      customer_id: `cus_bca_personal_${ts}`,
      product_id: "prod_pro",
      amount: 800,
      cancel_at_period_end: false,
      current_period_start: start,
      current_period_end: end,
      pending_update: null,
    });
    const asked = await ask(owner, ownerKey, { teamId: null, change: { kind: "cancel" } });
    expect(asked.status).toBe(202);
    expect(asked.body.approval.summary).toContain("Nothing is charged now.");

    const decided = await approve(owner, asked.body.approval.code);
    expect(decided.result).toMatchObject({ executed: true, applied: "renewal" });
    expect(fake.updates).toEqual([{ id: PERSONAL_SUB, body: { cancel_at_period_end: true } }]);
    const { data: user } = await admin
      .from("users")
      .select("cancel_at_period_end")
      .eq("id", owner)
      .single();
    expect(user!.cancel_at_period_end).toBe(true);

    // Asking to cancel again is refused before anyone is asked.
    const twice = await ask(owner, ownerKey, { teamId: null, change: { kind: "cancel" } });
    expect(twice.status).toBe(409);
  });
});
