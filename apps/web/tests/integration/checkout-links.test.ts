import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  bearer,
  cleanupRegistrations,
  configureAgentEnv,
  loadAgentRoutes,
  sandboxAgent,
} from "./agent-helpers";

/**
 * Checkout links (migration 00104) against the local database: the routes
 * with real API keys, the per-account limits in reserve_billing_checkout(),
 * the team owner rail, the Polar webhook marking a link paid, and the lazy
 * expiry on read. Polar is mocked: no checkout is ever made.
 */

const polar = vi.hoisted(() => {
  let n = 0;
  return {
    create: vi.fn(async (input: Record<string, unknown>) => {
      n += 1;
      return {
        id: `polar_checkout_${n}_${Date.now()}`,
        url: `https://sandbox.polar.sh/checkout/polar_c_test_${n}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        input,
      };
    }),
    get: vi.fn(),
    customersCreate: vi.fn(async () => ({ id: `cus_test_${Date.now()}_${Math.random()}` })),
    validateEvent: vi.fn(),
  };
});

vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  return {
    ...actual,
    createPolarClient: () => ({
      checkouts: { create: polar.create, get: polar.get, update: vi.fn() },
      customers: { create: polar.customersCreate },
      subscriptions: { update: vi.fn(), get: vi.fn(), revoke: vi.fn() },
    }),
    getPolarWebhookSecret: () => "whsec_test",
  };
});

vi.mock("@polar-sh/sdk/2026-10", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polar-sh/sdk/2026-10")>();
  return { ...actual, webhooks: { ...actual.webhooks, validateEvent: polar.validateEvent } };
});

configureAgentEnv();

import { generateApiKey, hashApiKey } from "@/lib/supabase/api-keys";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Handler = (request: Request) => Promise<Response>;
/** What the routes answer: a link, or an error with its code. */
interface Answer {
  checkout: {
    id: string;
    status: string;
    url: string | null;
    paidAt: string | null;
    [key: string]: unknown;
  };
  code?: string;
}
let createRoute: Handler;
let getRoute: (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let webhookRoute: Handler;

const ts = Date.now();
const users: string[] = [];
const teams: string[] = [];
const registrations = new Set<string>();
const saved: Record<string, string | undefined> = {};

async function makeUser(label: string, fields: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-checkout-links-${label}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const id = data.user!.id;
  users.push(id);
  if (Object.keys(fields).length > 0) {
    const { error: updateError } = await admin.from("users").update(fields).eq("id", id);
    if (updateError) throw updateError;
  }
  return id;
}

/** A real API key for the user: its raw value and its row's id. */
async function makeKey(userId: string): Promise<{ raw: string; id: string }> {
  const raw = generateApiKey();
  const { data, error } = await admin
    .from("api_keys")
    .insert({
      user_id: userId,
      name: "Agent",
      key_hash: hashApiKey(raw),
      key_prefix: raw.slice(0, 12),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { raw, id: data.id as string };
}

async function makeTeam(owner: string, member?: string): Promise<string> {
  const { data, error } = await admin.rpc("create_team_with_owner", {
    p_user_id: owner,
    p_name: `Checkout links ${ts}`,
  });
  if (error) throw error;
  const team = data as { id?: string; error?: string };
  if (!team.id) throw new Error(`create_team_with_owner failed: ${team.error}`);
  teams.push(team.id);
  if (member) {
    const { error: memberError } = await admin
      .from("team_members")
      .insert({ team_id: team.id, user_id: member, role: "member" });
    if (memberError) throw memberError;
  }
  return team.id;
}

async function create(token: string, body: unknown) {
  const response = await createRoute(bearer("POST", "/api/billing/checkouts", token, body));
  return { status: response.status, body: (await response.json()) as Answer };
}

async function read(token: string, id: string) {
  const response = await getRoute(bearer("GET", `/api/billing/checkouts/${id}`, token), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: (await response.json()) as Answer };
}

async function deliver(type: string, data: Record<string, unknown>) {
  polar.validateEvent.mockResolvedValueOnce({ type, data });
  const response = await webhookRoute(
    new Request("https://webhooks.cc/api/polar-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": `evt_${Math.random()}`,
        "webhook-signature": "sig",
        "webhook-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: "{}",
    })
  );
  expect(response.status).toBe(200);
}

async function rows(column: "user_id" | "team_id", id: string) {
  const { data, error } = await admin
    .from("billing_checkouts")
    .select("*")
    .eq(column, id)
    .order("created_at");
  if (error) throw error;
  return data as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  for (const [key, value] of Object.entries({
    POLAR_PRO_PRODUCT_ID: "prod_pro_test",
    POLAR_BUSINESS_PRODUCT_ID: "prod_business_test",
    POLAR_TEAMS_PRODUCT_ID: "prod_teams_test",
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  [createRoute, getRoute, webhookRoute] = await Promise.all([
    import("@/app/api/billing/checkouts/route").then((m) => m.POST),
    import("@/app/api/billing/checkouts/[id]/route").then((m) => m.GET),
    import("@/app/api/polar-webhook/route").then((m) => m.POST),
  ]);
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanupRegistrations(admin, registrations);
  for (const id of teams) await admin.from("teams").delete().eq("id", id);
  for (const id of users) await admin.auth.admin.deleteUser(id);
});

beforeEach(() => {
  polar.create.mockClear();
  polar.get.mockReset();
});

describe("checkout links", () => {
  it("hands an API key a Pro checkout that lands on the public page, then marks it paid", async () => {
    const userId = await makeUser("pro");
    const key = await makeKey(userId);

    const made = await create(key.raw, { kind: "plan", plan: "pro" });
    expect(made.status).toBe(201);
    const link = made.body.checkout;
    expect(link).toMatchObject({
      status: "open",
      kind: "plan",
      item: { kind: "plan", plan: "pro", interval: "month" },
      summary: "The Pro plan, billed monthly.",
      teamId: null,
    });
    expect(link.url).toMatch(/^https:\/\/sandbox\.polar\.sh\/checkout\//);
    const input = polar.create.mock.calls[0][0];
    expect(input.products).toEqual(["prod_pro_test"]);
    expect(String(input.success_url)).toMatch(/\/checkout\/complete$/);
    expect(input.customer_id).toMatch(/^cus_test_/);

    const [stored] = await rows("user_id", userId);
    expect(stored).toMatchObject({
      id: link.id,
      created_by: userId,
      requested_by_key: key.id,
      status: "open",
    });

    // Audited, with what it buys.
    const { data: audits } = await admin
      .from("audit_events")
      .select("action, outcome, target_id, via")
      .eq("actor_user_id", userId)
      .eq("action", "billing.checkout_link_created");
    expect(audits).toEqual([
      {
        action: "billing.checkout_link_created",
        outcome: "ok",
        target_id: link.id,
        via: "api_key",
      },
    ]);

    // The order Polar makes for the checkout marks it paid, once.
    await deliver("order.paid", {
      id: `order_${ts}`,
      checkout_id: stored.polar_checkout_id,
      customer_id: input.customer_id,
      product_id: "prod_pro_test",
      status: "paid",
    });
    const paid = await read(key.raw, link.id);
    expect(paid.status).toBe(200);
    expect(paid.body.checkout).toMatchObject({ status: "paid", url: null });
    const paidAt = paid.body.checkout.paidAt;
    expect(paidAt).toBeTruthy();
    await deliver("order.paid", { id: `order_${ts}`, checkout_id: stored.polar_checkout_id });
    expect((await read(key.raw, link.id)).body.checkout.paidAt).toBe(paidAt);

    // Only the person who asked can read it.
    const stranger = await makeKey(await makeUser("stranger"));
    expect((await read(stranger.raw, link.id)).status).toBe(404);
  });

  it("refuses a plan the account already has, and leaves no link behind", async () => {
    const userId = await makeUser("already", {
      plan: "pro",
      polar_subscription_id: `sub_${ts}`,
      subscription_status: "active",
    });
    const key = await makeKey(userId);
    const refused = await create(key.raw, { kind: "plan", plan: "business" });
    expect(refused.status).toBe(409);
    expect(polar.create).not.toHaveBeenCalled();
    expect(await rows("user_id", userId)).toEqual([]);
  });

  it("holds an account to 3 open links and 5 an hour", async () => {
    const userId = await makeUser("limits");
    const key = await makeKey(userId);
    const body = { kind: "plan", plan: "pro" };

    for (let i = 0; i < 3; i++) expect((await create(key.raw, body)).status).toBe(201);
    const fourth = await create(key.raw, body);
    expect(fourth.status).toBe(409);
    expect(fourth.body.code).toBe("too_many_open");

    // Expired links no longer count as open, but still count for the hour.
    await admin.from("billing_checkouts").update({ status: "expired" }).eq("user_id", userId);
    for (let i = 0; i < 2; i++) expect((await create(key.raw, body)).status).toBe(201);
    const sixth = await create(key.raw, body);
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe("rate_limited");
    expect(await rows("user_id", userId)).toHaveLength(5);
  });

  it("lets only a team's owner buy for it, and reuses the team's one open session", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    const teamId = await makeTeam(owner, member);
    const ownerKey = await makeKey(owner);
    const memberKey = await makeKey(member);
    const body = { kind: "team_plan", teamId, seats: 3 };

    const refused = await create(memberKey.raw, body);
    expect(refused.status).toBe(403);
    expect(await rows("team_id", teamId)).toEqual([]);

    const made = await create(ownerKey.raw, body);
    expect(made.status).toBe(201);
    expect(made.body.checkout).toMatchObject({ teamId, kind: "team_plan" });
    expect(String(polar.create.mock.calls[0][0].success_url)).toMatch(/\/checkout\/complete$/);

    // The same purchase again is the same Polar session, so the same link.
    const again = await create(ownerKey.raw, body);
    expect(again.status).toBe(201);
    expect(again.body.checkout.id).toBe(made.body.checkout.id);
    expect(polar.create).toHaveBeenCalledTimes(1);
    expect(await rows("team_id", teamId)).toHaveLength(1);

    // A member's add-on purchase for the team is refused too.
    const blocks = await create(memberKey.raw, { kind: "blocks", blocks: 1, teamId });
    expect(blocks.status).toBe(403);
  });

  it("refuses a pre-claim agent token", async () => {
    const routes = await loadAgentRoutes();
    const agent = await sandboxAgent(routes, registrations);
    const refused = await create(agent.token, { kind: "plan", plan: "pro" });
    expect(refused.status).toBe(403);
    expect(polar.create).not.toHaveBeenCalled();
  });

  it("settles a link past its expiry from Polar when it is read", async () => {
    const userId = await makeUser("expiry");
    const key = await makeKey(userId);
    const made = await create(key.raw, { kind: "plan", plan: "pro" });
    expect(made.status).toBe(201);
    await admin
      .from("billing_checkouts")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", made.body.checkout.id);

    polar.get.mockResolvedValueOnce({ status: "expired" });
    const expired = await read(key.raw, made.body.checkout.id);
    expect(expired.body.checkout).toMatchObject({ status: "expired", url: null });

    // A payment that arrives late still wins.
    const [stored] = await rows("user_id", userId);
    await deliver("checkout.updated", { id: stored.polar_checkout_id, status: "succeeded" });
    expect((await read(key.raw, made.body.checkout.id)).body.checkout.status).toBe("paid");
  });
});
