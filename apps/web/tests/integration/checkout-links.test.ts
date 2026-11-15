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
 * with real API keys and real sessions, the per-account limits in
 * reserve_billing_checkout(), the owner rail on the page's open route, the
 * team's one open session, the Polar webhook marking a link paid (or
 * superseded), and the lazy expiry on read. Polar is mocked: no checkout is
 * ever made.
 */

const polar = vi.hoisted(() => {
  let n = 0;
  /** Polar's sessions as the mock holds them, by id. */
  const sessions = new Map<string, Record<string, unknown>>();
  return {
    sessions,
    create: vi.fn(async (input: Record<string, unknown>) => {
      n += 1;
      const id = `polar_checkout_${n}_${Date.now()}`;
      const session = {
        id,
        url: `https://sandbox.polar.sh/checkout/polar_c_test_${n}`,
        status: "open",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        product_id: (input.products as string[])[0],
        seats: (input.seats as number | undefined) ?? null,
        units: (input.units as number | undefined) ?? null,
        metadata: input.metadata ?? {},
        input,
      };
      sessions.set(id, session);
      return session;
    }),
    get: vi.fn(async (id: string) => sessions.get(id) ?? { id, status: "expired" }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const session = sessions.get(id) ?? { id };
      Object.assign(session, patch);
      sessions.set(id, session);
      return session;
    }),
    // Polar's current state of a subscription; undefined falls back to the event's.
    subscriptionGet: vi.fn(),
    subscriptionRevoke: vi.fn(async (id: string) => ({ id })),
    customersCreate: vi.fn(async () => ({ id: `cus_test_${Date.now()}_${Math.random()}` })),
    validateEvent: vi.fn(),
  };
});

vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  return {
    ...actual,
    createPolarClient: () => ({
      checkouts: { create: polar.create, get: polar.get, update: polar.update },
      customers: { create: polar.customersCreate },
      subscriptions: {
        update: vi.fn(),
        get: polar.subscriptionGet,
        revoke: polar.subscriptionRevoke,
      },
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
const anon = createClient(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Handler = (request: Request) => Promise<Response>;
type IdHandler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
/** What the routes answer: a link, or an error with its code. */
interface Answer {
  checkout: {
    id: string;
    status: string;
    url: string | null;
    paidAt: string | null;
    bought: Record<string, unknown> | null;
    matches: boolean | null;
    [key: string]: unknown;
  };
  code?: string;
}
let createRoute: Handler;
let getRoute: IdHandler;
let openRoute: IdHandler;
let reviewRoute: IdHandler;
let cancelRoute: IdHandler;
let webhookRoute: Handler;

const ts = Date.now();
const PASSWORD = "TestPassword123!";
const users: string[] = [];
const emails = new Map<string, string>();
const teams: string[] = [];
const registrations = new Set<string>();
const saved: Record<string, string | undefined> = {};

async function makeUser(label: string, fields: Record<string, unknown> = {}): Promise<string> {
  const email = `test-checkout-links-${label}-${ts}@webhooks-test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  const id = data.user!.id;
  users.push(id);
  emails.set(id, email);
  if (Object.keys(fields).length > 0) {
    const { error: updateError } = await admin.from("users").update(fields).eq("id", id);
    if (updateError) throw updateError;
  }
  return id;
}

/** A browser session's access token for the user. */
async function sessionToken(userId: string): Promise<string> {
  const { data, error } = await anon.auth.signInWithPassword({
    email: emails.get(userId)!,
    password: PASSWORD,
  });
  if (error) throw error;
  return data.session!.access_token;
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

/** What the link's page gets when it opens the link with a session. */
async function open(token: string, id: string) {
  const response = await openRoute(bearer("POST", `/api/billing/checkouts/${id}/open`, token), {
    params: Promise.resolve({ id }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { status?: string; url?: string; code?: string },
  };
}

/** What the link's page reads before the person continues, from a browser at `ip`. */
async function review(token: string, id: string, ip?: string) {
  const request = bearer("GET", `/api/billing/checkouts/${id}/review`, token);
  if (ip) request.headers.set("cf-connecting-ip", ip);
  const response = await reviewRoute(request, { params: Promise.resolve({ id }) });
  return {
    status: response.status,
    body: (await response.json()) as { review?: Record<string, unknown>; code?: string },
  };
}

async function cancel(token: string, id: string) {
  const response = await cancelRoute(bearer("DELETE", `/api/billing/checkouts/${id}`, token), {
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

async function stored(id: string) {
  const { data, error } = await admin.from("billing_checkouts").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Record<string, unknown>;
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
  [createRoute, getRoute, openRoute, reviewRoute, cancelRoute, webhookRoute] = await Promise.all([
    import("@/app/api/billing/checkouts/route").then((m) => m.POST),
    import("@/app/api/billing/checkouts/[id]/route").then((m) => m.GET),
    import("@/app/api/billing/checkouts/[id]/open/route").then((m) => m.POST),
    import("@/app/api/billing/checkouts/[id]/review/route").then((m) => m.GET),
    import("@/app/api/billing/checkouts/[id]/route").then((m) => m.DELETE),
    import("@/app/api/polar-webhook/route").then((m) => m.POST),
  ]);
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanupRegistrations(admin, registrations);
  for (const id of teams) {
    await admin.from("polar_refunds").delete().eq("team_id", id);
    await admin.from("teams").delete().eq("id", id);
  }
  for (const id of users) await admin.auth.admin.deleteUser(id);
});

beforeEach(() => {
  polar.create.mockClear();
  polar.get.mockClear();
  polar.update.mockClear();
  polar.subscriptionGet.mockReset();
  polar.subscriptionRevoke.mockClear();
});

describe("checkout links", () => {
  it("hands an API key our page, makes Polar's checkout only for the owner's session, then marks it paid", async () => {
    polar.customersCreate.mockClear();
    const userId = await makeUser("pro");
    const key = await makeKey(userId);
    const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL!).origin;

    const made = await create(key.raw, { kind: "plan", plan: "pro" });
    expect(made.status).toBe(201);
    const link = made.body.checkout;
    expect(link).toMatchObject({
      status: "open",
      kind: "plan",
      item: { kind: "plan", plan: "pro", interval: "month" },
      summary: "The Pro plan, billed monthly.",
      teamId: null,
      url: `${appOrigin}/checkout/${link.id}`,
      bought: null,
      matches: null,
    });
    // Nothing in Polar yet: no session, no customer.
    expect(polar.create).not.toHaveBeenCalled();
    expect(polar.customersCreate).not.toHaveBeenCalled();
    expect(await stored(link.id)).toMatchObject({
      created_by: userId,
      requested_by_key: key.id,
      status: "open",
      polar_checkout_id: null,
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

    // A key cannot open it: Polar's checkout never reaches one.
    expect((await open(key.raw, link.id)).status).toBe(403);
    expect(polar.create).not.toHaveBeenCalled();

    // The owner's session opens it and is sent on to Polar.
    const token = await sessionToken(userId);
    const opened = await open(token, link.id);
    expect(opened.status).toBe(200);
    expect(opened.body.status).toBe("redirect");
    expect(opened.body.url).toMatch(/^https:\/\/sandbox\.polar\.sh\/checkout\//);
    const input = polar.create.mock.calls[0][0];
    expect(input.products).toEqual(["prod_pro_test"]);
    expect(input.metadata).toEqual({ checkout_link: link.id });
    expect(String(input.success_url)).toBe(`${appOrigin}/checkout/complete`);
    expect(input.customer_id).toMatch(/^cus_test_/);
    const sessionId = String((await stored(link.id)).polar_checkout_id);
    expect(sessionId).toMatch(/^polar_checkout_/);
    expect((await stored(link.id)).expected).toEqual({ product: "prod_pro_test" });

    // A reopen goes back to the same session while Polar has it open.
    expect((await open(token, link.id)).body.url).toBe(opened.body.url);
    expect(polar.create).toHaveBeenCalledTimes(1);

    // The asker's view never carries Polar's checkout.
    const view = JSON.stringify((await read(key.raw, link.id)).body);
    expect(view).not.toContain("sandbox.polar.sh");
    expect(view).not.toContain(sessionId);

    // The order Polar makes for the session marks it paid, once, with what it holds.
    await deliver("order.paid", {
      id: `order_${ts}`,
      checkout_id: sessionId,
      customer_id: input.customer_id,
      product_id: "prod_pro_test",
      status: "paid",
      net_amount: 900,
      currency: "usd",
      metadata: { checkout_link: link.id },
    });
    const paid = await read(key.raw, link.id);
    expect(paid.status).toBe(200);
    // A key learns what was bought, never what the person paid.
    expect(paid.body.checkout).toMatchObject({
      status: "paid",
      url: null,
      bought: { product: "prod_pro_test", amount: null, currency: "usd" },
      matches: true,
    });
    expect((await read(token, link.id)).body.checkout.bought).toMatchObject({ amount: 900 });
    const paidAt = paid.body.checkout.paidAt;
    expect(paidAt).toBeTruthy();
    await deliver("order.paid", { id: `order_${ts}`, checkout_id: sessionId });
    expect((await read(key.raw, link.id)).body.checkout.paidAt).toBe(paidAt);
    // Opened again, it says so.
    expect((await open(token, link.id)).body.status).toBe("paid");

    // Only the person who asked can read it, and only the account's owner open it.
    const strangerId = await makeUser("stranger");
    const stranger = await makeKey(strangerId);
    expect((await read(stranger.raw, link.id)).status).toBe(404);
    const refused = await open(await sessionToken(strangerId), link.id);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("wrong_account");
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

  it("checks again when the link is opened", async () => {
    const userId = await makeUser("recheck");
    const key = await makeKey(userId);
    const made = await create(key.raw, { kind: "plan", plan: "pro" });
    expect(made.status).toBe(201);
    // The account got a plan meanwhile.
    await admin
      .from("users")
      .update({
        plan: "pro",
        polar_subscription_id: `sub_recheck_${ts}`,
        subscription_status: "active",
      })
      .eq("id", userId);
    const opened = await open(await sessionToken(userId), made.body.checkout.id);
    expect(opened.status).toBe(409);
    expect(opened.body.code).toBe("already_pro");
    expect(polar.create).not.toHaveBeenCalled();
    expect((await stored(made.body.checkout.id)).opening_at).toBeNull();
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

  it("lets only a team's owner buy for it, through the team's one open session", async () => {
    const owner = await makeUser("owner");
    const member = await makeUser("member");
    const teamId = await makeTeam(owner, member);
    const ownerKey = await makeKey(owner);
    const memberKey = await makeKey(member);
    const ownerToken = await sessionToken(owner);
    const body = { kind: "team_plan", teamId, seats: 3 };

    const refused = await create(memberKey.raw, body);
    expect(refused.status).toBe(403);
    expect(await rows("team_id", teamId)).toEqual([]);

    const made = await create(ownerKey.raw, body);
    expect(made.status).toBe(201);
    expect(made.body.checkout).toMatchObject({ teamId, kind: "team_plan" });
    expect(polar.create).not.toHaveBeenCalled();
    const first = made.body.checkout.id;

    // A member's session cannot open the owner's link.
    const memberOpen = await open(await sessionToken(member), first);
    expect(memberOpen.status).toBe(403);
    expect(memberOpen.body.code).toBe("wrong_account");

    // Opened by the owner with no session open: one of its own, one plan,
    // exactly its seats, cached as the team's open one.
    const opened = await open(ownerToken, first);
    expect(opened.body.status).toBe("redirect");
    expect(polar.create).toHaveBeenCalledTimes(1);
    expect(polar.create.mock.calls[0][0]).toMatchObject({
      products: ["prod_teams_test"],
      seats: 3,
      min_seats: 3,
      max_seats: 3,
      metadata: { checkout_link: first },
    });
    const teamOpen = async () =>
      (await admin.from("teams").select("pending_checkout").eq("id", teamId).single()).data
        ?.pending_checkout as Record<string, unknown>;
    const firstSession = String((await stored(first)).polar_checkout_id);
    expect(await teamOpen()).toMatchObject({ id: firstSession, seats: 3, fixed: true });

    // Another link for the same purchase reuses that session, and names itself on it.
    const same = await create(ownerKey.raw, body);
    const sameOpened = await open(ownerToken, same.body.checkout.id);
    expect(sameOpened.body.url).toBe(opened.body.url);
    expect(polar.create).toHaveBeenCalledTimes(1);
    expect(polar.update).toHaveBeenCalledWith(firstSession, {
      metadata: { checkout_link: same.body.checkout.id },
    });
    expect((await stored(same.body.checkout.id)).polar_checkout_id).toBe(firstSession);

    // Another seat count cannot move a fixed session: it gets its own,
    // which becomes the team's open one.
    const more = await create(ownerKey.raw, { ...body, seats: 5 });
    expect(more.status).toBe(201);
    const moreOpened = await open(ownerToken, more.body.checkout.id);
    expect(polar.create).toHaveBeenCalledTimes(2);
    expect(polar.create.mock.calls[1][0]).toMatchObject({ seats: 5, min_seats: 5, max_seats: 5 });
    expect(moreOpened.body.url).not.toBe(opened.body.url);
    const moreSession = String((await stored(more.body.checkout.id)).polar_checkout_id);
    expect(await teamOpen()).toMatchObject({ id: moreSession, seats: 5, fixed: true });

    // The first link still goes to its own session, which still sells 3 seats.
    expect((await open(ownerToken, first)).body.url).toBe(opened.body.url);
    expect(polar.create).toHaveBeenCalledTimes(2);

    // A member's add-on purchase for the team is refused too.
    const blocks = await create(memberKey.raw, { kind: "blocks", blocks: 1, teamId });
    expect(blocks.status).toBe(403);
  });

  it("ends and refunds the second team subscription, and its link reads superseded", async () => {
    const owner = await makeUser("two-paid");
    const teamId = await makeTeam(owner);
    const ownerKey = await makeKey(owner);
    const ownerToken = await sessionToken(owner);

    // Two links for different seat counts, both opened: two sessions.
    const three = (await create(ownerKey.raw, { kind: "team_plan", teamId, seats: 3 })).body
      .checkout.id;
    const five = (await create(ownerKey.raw, { kind: "team_plan", teamId, seats: 5 })).body.checkout
      .id;
    expect((await open(ownerToken, three)).body.status).toBe("redirect");
    expect((await open(ownerToken, five)).body.status).toBe("redirect");
    expect(polar.create).toHaveBeenCalledTimes(2);
    const customerId = String(polar.create.mock.calls[0][0].customer_id);
    const threeSession = String((await stored(three)).polar_checkout_id);
    const fiveSession = String((await stored(five)).polar_checkout_id);

    // Both are paid: each makes a live subscription, the second a minute later.
    const first = `sub_first_${ts}`;
    const second = `sub_second_${ts}`;
    const state: Record<string, Record<string, unknown>> = {};
    const subscription = (id: string, seats: number, checkoutId: string, startedAt: Date) => {
      state[id] = {
        id,
        status: "active",
        ended_at: null,
        seats,
        product_id: "prod_teams_test",
        customer_id: customerId,
        checkout_id: checkoutId,
        started_at: startedAt.toISOString(),
        current_period_start: startedAt.toISOString(),
        current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        cancel_at_period_end: false,
        pending_update: null,
      };
      return { ...state[id], customer: { id: customerId, metadata: { teamId } } };
    };
    polar.subscriptionGet.mockImplementation(async (id: string) => state[id]);
    polar.subscriptionRevoke.mockImplementation(async (id: string) => {
      state[id] = { ...state[id], status: "canceled", ended_at: new Date().toISOString() };
      return { id };
    });

    await deliver(
      "subscription.created",
      subscription(first, 3, threeSession, new Date(Date.now() - 60_000))
    );
    const secondEvent = subscription(second, 5, fiveSession, new Date());
    await deliver("subscription.created", secondEvent);

    const { data: team } = await admin
      .from("teams")
      .select("polar_subscription_id, subscription_status, seats")
      .eq("id", teamId)
      .single();
    expect(team).toEqual({ polar_subscription_id: first, subscription_status: "active", seats: 3 });
    expect(polar.subscriptionRevoke).toHaveBeenCalledTimes(1);
    expect(polar.subscriptionRevoke).toHaveBeenCalledWith(second);

    // The kept one's link is paid with what it holds; the ended one's is superseded.
    expect((await read(ownerKey.raw, three)).body.checkout).toMatchObject({
      status: "paid",
      bought: { product: "prod_teams_test", seats: 3 },
      matches: true,
    });
    expect((await read(ownerKey.raw, five)).body.checkout.status).toBe("superseded");
    // Its order arriving later does not make it paid.
    await deliver("order.paid", {
      id: `order_second_${ts}`,
      checkout_id: fiveSession,
      customer_id: customerId,
      product_id: "prod_teams_test",
      customer: { id: customerId, metadata: { teamId } },
    });
    expect((await read(ownerKey.raw, five)).body.checkout.status).toBe("superseded");

    // A redelivery after the revoke reads it as ended and records nothing more.
    await deliver("subscription.created", secondEvent);
    const { data: refunds, error } = await admin
      .from("polar_refunds")
      .select("target, reason, team_id, user_id")
      .eq("team_id", teamId);
    if (error) throw error;
    expect(refunds).toEqual([
      {
        target: `subscription:${second}`,
        reason: "duplicate_plan",
        team_id: teamId,
        user_id: null,
      },
    ]);
    expect(polar.subscriptionRevoke).toHaveBeenCalledTimes(1);
  });

  it("supersedes a link that never stored its session, named only in the metadata", async () => {
    const userId = await makeUser("never-stored");
    const key = await makeKey(userId);
    const id = (await create(key.raw, { kind: "plan", plan: "pro" })).body.checkout.id;
    // The write after minting failed: the link never learned its session.
    expect(await stored(id)).toMatchObject({ status: "open", polar_checkout_id: null });

    // Meanwhile the account got Pro from another checkout.
    const kept = `sub_kept_${ts}`;
    const customerId = `cus_never_stored_${ts}`;
    await admin
      .from("users")
      .update({
        plan: "pro",
        polar_customer_id: customerId,
        polar_subscription_id: kept,
        subscription_status: "active",
      })
      .eq("id", userId);
    const duplicate = `sub_dup_${ts}`;
    const session = `polar_checkout_never_stored_${ts}`;
    const state: Record<string, Record<string, unknown>> = {};
    const live = (subscriptionId: string, checkoutId: string | null) => ({
      id: subscriptionId,
      status: "active",
      ended_at: null,
      product_id: "prod_pro_test",
      customer_id: customerId,
      checkout_id: checkoutId,
      metadata: checkoutId === session ? { checkout_link: id } : {},
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
      pending_update: null,
    });
    state[kept] = live(kept, null);
    state[duplicate] = live(duplicate, session);
    polar.subscriptionGet.mockImplementation(
      async (subscriptionId: string) => state[subscriptionId]
    );
    polar.subscriptionRevoke.mockImplementation(async (subscriptionId: string) => {
      state[subscriptionId] = {
        ...state[subscriptionId],
        status: "canceled",
        ended_at: new Date().toISOString(),
      };
      return { id: subscriptionId };
    });

    // The link's session made a second plan subscription: ended and refunded,
    // and the link reads superseded although no link follows that session.
    await deliver("subscription.created", {
      ...state[duplicate],
      customer: { id: customerId, metadata: { userId } },
    });
    expect(polar.subscriptionRevoke).toHaveBeenCalledWith(duplicate);
    expect(await stored(id)).toMatchObject({ status: "superseded", polar_checkout_id: session });
    expect((await stored(id)).paid_at).not.toBeNull();

    // Its order arriving later, naming the link too, does not make it paid.
    await deliver("order.paid", {
      id: `order_never_stored_${ts}`,
      checkout_id: session,
      subscription_id: duplicate,
      customer_id: customerId,
      product_id: "prod_pro_test",
      metadata: { checkout_link: id },
      customer: { id: customerId, metadata: { userId } },
    });
    expect((await read(key.raw, id)).body.checkout.status).toBe("superseded");
    const { data: refunds } = await admin
      .from("polar_refunds")
      .select("target, reason")
      .eq("user_id", userId);
    expect(refunds).toEqual([{ target: `subscription:${duplicate}`, reason: "duplicate_plan" }]);
    await admin.from("polar_refunds").delete().eq("user_id", userId);
  });

  it("leaves a team plan subscription that started before the one the team holds to a person", async () => {
    const owner = await makeUser("older-foreign");
    const teamId = await makeTeam(owner);
    const customerId = `cus_older_${ts}`;
    const held = `sub_held_${ts}`;
    const older = `sub_older_${ts}`;
    const subscription = (subscriptionId: string, startedAt: Date) => ({
      id: subscriptionId,
      status: "active",
      ended_at: null,
      seats: 3,
      product_id: "prod_teams_test",
      customer_id: customerId,
      checkout_id: null,
      started_at: startedAt.toISOString(),
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
      pending_update: null,
    });
    const state: Record<string, Record<string, unknown>> = {
      [held]: subscription(held, new Date()),
      // Live all along, its row cleared by a revoked event: months were used.
      [older]: subscription(older, new Date(Date.now() - 90 * 86_400_000)),
    };
    polar.subscriptionGet.mockImplementation(
      async (subscriptionId: string) => state[subscriptionId]
    );
    await admin
      .from("teams")
      .update({
        polar_customer_id: customerId,
        polar_subscription_id: held,
        subscription_status: "active",
        seats: 3,
      })
      .eq("id", teamId);

    await deliver("subscription.updated", {
      ...state[older],
      customer: { id: customerId, metadata: { teamId } },
    });

    expect(polar.subscriptionRevoke).not.toHaveBeenCalled();
    const { data: refunds } = await admin.from("polar_refunds").select("id").eq("team_id", teamId);
    expect(refunds).toEqual([]);
    const { data: team } = await admin
      .from("teams")
      .select("polar_subscription_id")
      .eq("id", teamId)
      .single();
    expect(team?.polar_subscription_id).toBe(held);
  });

  it("refuses a pre-claim agent token", async () => {
    const routes = await loadAgentRoutes();
    const agent = await sandboxAgent(routes, registrations);
    const refused = await create(agent.token, { kind: "plan", plan: "pro" });
    expect(refused.status).toBe(403);
    expect(polar.create).not.toHaveBeenCalled();
  });

  it("settles a link past its expiry from Polar when it is read, at most every 30 seconds", async () => {
    const userId = await makeUser("expiry");
    const key = await makeKey(userId);
    const token = await sessionToken(userId);
    const past = new Date(Date.now() - 60_000).toISOString();

    // Never opened: expired without asking Polar.
    const unopened = await create(key.raw, { kind: "plan", plan: "pro" });
    await admin
      .from("billing_checkouts")
      .update({ expires_at: past })
      .eq("id", unopened.body.checkout.id);
    expect((await read(key.raw, unopened.body.checkout.id)).body.checkout.status).toBe("expired");
    expect(polar.get).not.toHaveBeenCalled();
    expect((await open(token, unopened.body.checkout.id)).body.status).toBe("expired");

    // Opened: Polar says how it ended.
    const made = await create(key.raw, { kind: "plan", plan: "pro" });
    const id = made.body.checkout.id;
    await open(token, id);
    const sessionId = String((await stored(id)).polar_checkout_id);
    await admin.from("billing_checkouts").update({ expires_at: past }).eq("id", id);
    polar.get.mockClear();
    polar.get.mockResolvedValueOnce({ id: sessionId, status: "confirmed" });
    expect((await read(key.raw, id)).body.checkout.status).toBe("open");
    // Asked again within 30 seconds: Polar is not.
    expect((await read(key.raw, id)).body.checkout.status).toBe("open");
    expect(polar.get).toHaveBeenCalledTimes(1);

    await admin
      .from("billing_checkouts")
      .update({ polar_checked_at: new Date(Date.now() - 31_000).toISOString() })
      .eq("id", id);
    polar.get.mockResolvedValueOnce({ id: sessionId, status: "expired" });
    expect((await read(key.raw, id)).body.checkout).toMatchObject({ status: "expired", url: null });
    expect(polar.get).toHaveBeenCalledTimes(2);

    // A payment that arrives late still wins.
    await deliver("checkout.updated", {
      id: sessionId,
      status: "succeeded",
      product_id: "prod_pro_test",
    });
    expect((await read(key.raw, id)).body.checkout).toMatchObject({
      status: "paid",
      matches: true,
    });
  });

  it("links to the site the asker uses, and returns the payer there", async () => {
    const savedMail = process.env.NEXT_PUBLIC_MAILHOOKS_URL;
    process.env.NEXT_PUBLIC_MAILHOOKS_URL = "http://mailhooks.localhost:3020";
    try {
      const userId = await makeUser("mail-site", { home_site: "mailhooks" });
      const key = await makeKey(userId);
      const made = await create(key.raw, { kind: "plan", plan: "pro" });
      expect(made.body.checkout.url).toBe(
        `http://mailhooks.localhost:3020/checkout/${made.body.checkout.id}`
      );
      await open(await sessionToken(userId), made.body.checkout.id);
      expect(polar.create.mock.calls[0][0].success_url).toBe(
        "http://mailhooks.localhost:3020/checkout/complete"
      );

      const owner = await makeUser("mail-owner", { home_site: "mailhooks" });
      const teamId = await makeTeam(owner);
      const ownerKey = await makeKey(owner);
      const team = await create(ownerKey.raw, { kind: "team_plan", teamId, seats: 2 });
      expect(team.body.checkout.url).toMatch(/^http:\/\/mailhooks\.localhost:3020\/checkout\//);

      // Someone who uses webhooks.cc goes there.
      const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL!).origin;
      const webUser = await makeUser("web-site", { home_site: "webhooks" });
      const webKey = await makeKey(webUser);
      const web = await create(webKey.raw, { kind: "plan", plan: "pro" });
      expect(web.body.checkout.url).toBe(`${appOrigin}/checkout/${web.body.checkout.id}`);

      // With one site configured, a mailhooks.cc account goes to webhooks.cc.
      delete process.env.NEXT_PUBLIC_MAILHOOKS_URL;
      const key2 = await makeKey(userId);
      const one = await create(key2.raw, { kind: "plan", plan: "business" });
      expect(one.body.checkout.url).toBe(`${appOrigin}/checkout/${one.body.checkout.id}`);
    } finally {
      if (savedMail === undefined) delete process.env.NEXT_PUBLIC_MAILHOOKS_URL;
      else process.env.NEXT_PUBLIC_MAILHOOKS_URL = savedMail;
    }
  });

  it("counts 30 attempts an hour per asking person, refused ones too, beside the 5 links", async () => {
    const userId = await makeUser("attempts", {
      plan: "pro",
      polar_subscription_id: `sub_attempts_${ts}`,
      subscription_status: "active",
    });
    const key = await makeKey(userId);
    // Each is refused (the account has a plan) and leaves no link behind.
    for (let i = 0; i < 30; i++) {
      expect((await create(key.raw, { kind: "plan", plan: "business" })).status).toBe(409);
    }
    const limited = await create(key.raw, { kind: "plan", plan: "business" });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBeUndefined();
    expect(await rows("user_id", userId)).toEqual([]);
    expect(polar.create).not.toHaveBeenCalled();

    // Another account is counted on its own.
    const other = await makeKey(await makeUser("attempts-other"));
    expect((await create(other.raw, { kind: "plan", plan: "pro" })).status).toBe(201);
  });

  it("leaves a team owner's attempts alone when a member uses theirs up", async () => {
    const owner = await makeUser("budget-owner");
    const member = await makeUser("budget-member");
    const teamId = await makeTeam(owner, member);
    const memberKey = await makeKey(member);
    const body = { kind: "team_plan", teamId, seats: 2 };
    for (let i = 0; i < 30; i++) expect((await create(memberKey.raw, body)).status).toBe(403);
    expect((await create(memberKey.raw, body)).status).toBe(429);
    expect((await create((await makeKey(owner)).raw, body)).status).toBe(201);
  });

  it("deletes links 30 days after they were paid, superseded or expired", async () => {
    const userId = await makeUser("cleanup");
    const day = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
    const make = (label: string, fields: Record<string, unknown>) => ({
      user_id: userId,
      created_by: userId,
      kind: "plan",
      item: { kind: "plan", plan: "pro", interval: "month" },
      url: "https://webhooks.cc/checkout/x",
      polar_checkout_id: `polar_cleanup_${label}_${ts}`,
      ...fields,
    });
    const { error } = await admin.from("billing_checkouts").insert([
      make("paid-old", {
        status: "paid",
        paid_at: ago(31),
        expires_at: ago(40),
        created_at: ago(41),
      }),
      make("paid-new", {
        status: "paid",
        paid_at: ago(29),
        expires_at: ago(40),
        created_at: ago(41),
      }),
      make("superseded-old", {
        status: "superseded",
        paid_at: ago(31),
        expires_at: ago(40),
        created_at: ago(41),
      }),
      make("expired-old", { status: "expired", expires_at: ago(31), created_at: ago(32) }),
      make("expired-new", { status: "expired", expires_at: ago(29), created_at: ago(30) }),
      // Never settled by a read: past its expiry all the same.
      make("open-old", { status: "open", expires_at: ago(31), created_at: ago(32) }),
      make("open-now", { status: "open", expires_at: ago(-1 / 24), created_at: ago(0) }),
    ]);
    if (error) throw error;

    const { data: deleted, error: cleanupError } = await admin.rpc("cleanup_billing_checkouts");
    if (cleanupError) throw cleanupError;
    expect(deleted).toBeGreaterThanOrEqual(4);
    const left = (await rows("user_id", userId)).map((row) =>
      String(row.polar_checkout_id).replace(`polar_cleanup_`, "").replace(`_${ts}`, "")
    );
    expect(left.sort()).toEqual(["expired-new", "open-now", "paid-new"]);
  });

  it("shows the owner what a link buys, who asked and from where, and makes nothing", async () => {
    const userId = await makeUser("review");
    const key = await makeKey(userId);
    const created = await createRoute(
      (() => {
        const request = bearer("POST", "/api/billing/checkouts", key.raw, {
          kind: "plan",
          plan: "pro",
        });
        request.headers.set("cf-connecting-ip", "203.0.113.7");
        request.headers.set("cf-ipcountry", "DK");
        return request;
      })()
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as Answer).checkout.id;
    expect(await stored(id)).toMatchObject({ network: "203.0.113.0/24", country: "DK" });

    const token = await sessionToken(userId);
    const same = await review(token, id, "203.0.113.200");
    expect(same.status).toBe(200);
    expect(same.body.review).toMatchObject({
      id,
      status: "open",
      summary: "The Pro plan, billed monthly.",
      price: "$8 a month",
      email: emails.get(userId),
      teamName: null,
      requester: { kind: "key", name: "Agent", prefix: key.raw.slice(0, 12) },
      unavailable: null,
      country: "DK",
      network: "same",
    });
    expect((await review(token, id, "198.51.100.1")).body.review?.network).toBe("different");

    // Reading made nothing: no session, no lease, no Polar call.
    expect(polar.create).not.toHaveBeenCalled();
    expect(polar.get).not.toHaveBeenCalled();
    expect(await stored(id)).toMatchObject({ polar_checkout_id: null, opening_at: null });

    // Once the account has a plan, the page says so before anything is made.
    await admin
      .from("users")
      .update({ plan: "pro", polar_subscription_id: `sub_review_${ts}` })
      .eq("id", userId);
    const refused = await review(token, id);
    expect(refused.body.review?.status).toBe("open");
    expect(refused.body.review?.unavailable).toEqual(expect.any(String));
    expect(polar.create).not.toHaveBeenCalled();

    // A key cannot read it this way, and nor can another account.
    expect((await review(key.raw, id)).status).toBe(403);
    const stranger = await review(await sessionToken(await makeUser("review-other")), id);
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe("wrong_account");
  });

  it("reads paid, not matching, when a session it replaced is the one paid", async () => {
    const userId = await makeUser("replaced");
    const key = await makeKey(userId);
    const token = await sessionToken(userId);
    const id = (await create(key.raw, { kind: "plan", plan: "pro" })).body.checkout.id;
    expect((await open(token, id)).body.status).toBe("redirect");
    const first = String((await stored(id)).polar_checkout_id);

    // Polar's session no longer sells what the link asks: a reopen replaces it.
    Object.assign(polar.sessions.get(first)!, { product_id: "prod_business_test" });
    expect((await open(token, id)).body.status).toBe("redirect");
    const second = String((await stored(id)).polar_checkout_id);
    expect(second).not.toBe(first);
    expect((await stored(id)).previous_checkout_ids).toEqual([first]);

    // The person pays the old one anyway (Polar cannot end it).
    await deliver("order.paid", {
      id: `order_replaced_${ts}`,
      checkout_id: first,
      product_id: "prod_business_test",
      status: "paid",
      net_amount: 2900,
      currency: "usd",
      metadata: { checkout_link: id },
    });
    expect(await stored(id)).toMatchObject({ status: "paid", mismatch: "replaced" });
    expect((await read(key.raw, id)).body.checkout).toMatchObject({
      status: "paid",
      bought: { product: "prod_business_test" },
      matches: false,
    });
  });

  it("never pays a cancelled link through a session's metadata", async () => {
    const userId = await makeUser("cancel-paid");
    const key = await makeKey(userId);
    const id = (await create(key.raw, { kind: "plan", plan: "pro" })).body.checkout.id;
    expect((await cancel(key.raw, id)).status).toBe(200);
    expect((await stored(id)).cancelled_at).toBeTruthy();

    // A session another tab made meanwhile names it, and is paid.
    await deliver("order.paid", {
      id: `order_cancelled_${ts}`,
      checkout_id: `polar_checkout_cancelled_${ts}`,
      product_id: "prod_pro_test",
      status: "paid",
      net_amount: 800,
      currency: "usd",
      metadata: { checkout_link: id },
    });
    expect(await stored(id)).toMatchObject({ status: "expired", polar_checkout_id: null });
  });

  it("cancels a link nobody opened, and refuses one already opened", async () => {
    const userId = await makeUser("cancel");
    const key = await makeKey(userId);
    const token = await sessionToken(userId);
    const unopened = (await create(key.raw, { kind: "plan", plan: "pro" })).body.checkout.id;

    const cancelled = await cancel(key.raw, unopened);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.checkout).toMatchObject({ status: "expired", url: null });
    // It can no longer be opened, and nothing was made in Polar.
    expect((await open(token, unopened)).body.status).toBe("expired");
    expect(polar.create).not.toHaveBeenCalled();
    // Cancelling again answers it as it is.
    expect((await cancel(key.raw, unopened)).status).toBe(200);

    const opened = (await create(key.raw, { kind: "plan", plan: "pro" })).body.checkout.id;
    expect((await open(token, opened)).body.status).toBe("redirect");
    const refused = await cancel(key.raw, opened);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("opened");
    expect((await stored(opened)).status).toBe("open");

    // Someone else's: not found.
    const stranger = await makeKey(await makeUser("cancel-other"));
    expect((await cancel(stranger.raw, opened)).status).toBe(404);

    const { data: audits } = await admin
      .from("audit_events")
      .select("outcome, target_id")
      .eq("actor_user_id", userId)
      .eq("action", "billing.checkout_link_canceled")
      .order("occurred_at");
    expect(audits).toEqual([
      { outcome: "ok", target_id: unopened },
      { outcome: "ok", target_id: unopened },
      { outcome: "refused", target_id: opened },
    ]);
  });

  it("follows a team link for the team's owner now, and drops it for a former owner's keys", async () => {
    const owner = await makeUser("follow-owner");
    const next = await makeUser("follow-next");
    const teamId = await makeTeam(owner, next);
    const ownerKey = await makeKey(owner);
    const nextKey = await makeKey(next);
    const id = (await create(ownerKey.raw, { kind: "team_plan", teamId, seats: 3 })).body.checkout
      .id;

    expect((await read(ownerKey.raw, id)).status).toBe(200);
    // A member who does not own the team.
    expect((await read(nextKey.raw, id)).status).toBe(404);

    // Both own it for a moment: the asker still owns the team, so either may follow.
    await admin
      .from("team_members")
      .update({ role: "owner" })
      .eq("team_id", teamId)
      .eq("user_id", next);
    expect((await read(nextKey.raw, id)).status).toBe(200);
    expect((await read(ownerKey.raw, id)).status).toBe(200);

    // The asker gave up the team: the link is no one's to follow now.
    await admin
      .from("team_members")
      .update({ role: "member" })
      .eq("team_id", teamId)
      .eq("user_id", owner);
    expect((await read(ownerKey.raw, id)).status).toBe(404);
    expect((await read(nextKey.raw, id)).status).toBe(404);
    expect((await cancel(ownerKey.raw, id)).status).toBe(404);
  });

  it("never pays a link let go of a team session through the session's old metadata", async () => {
    const owner = await makeUser("detach");
    const teamId = await makeTeam(owner);
    const ownerKey = await makeKey(owner);
    const ownerToken = await sessionToken(owner);
    const { createTeamCheckout } = await import("@/lib/supabase/team-billing");

    // The dashboard's open session for 3 seats; a link for the same is opened on it.
    await createTeamCheckout(owner, teamId, 3);
    const id = (await create(ownerKey.raw, { kind: "team_plan", teamId, seats: 3 })).body.checkout
      .id;
    expect((await open(ownerToken, id)).body.status).toBe("redirect");
    const sessionId = String((await stored(id)).polar_checkout_id);
    expect(polar.sessions.get(sessionId)?.metadata).toEqual({ checkout_link: id });

    // The dashboard moves it to 5 seats. Should Polar merge metadata rather
    // than replace it, the session still names the link.
    polar.update.mockImplementationOnce(async (checkoutId: string, patch) => {
      const session = polar.sessions.get(checkoutId)!;
      const metadata = { ...(session.metadata as object), ...(patch.metadata as object) };
      Object.assign(session, patch, { metadata });
      return session;
    });
    await createTeamCheckout(owner, teamId, 5);
    expect(polar.sessions.get(sessionId)?.metadata).toEqual({ checkout_link: id });
    expect(await stored(id)).toMatchObject({ polar_checkout_id: null, status: "open" });
    expect((await stored(id)).detached_at).not.toBeNull();

    // That session is paid for 5 seats: the link it no longer sells for stays open.
    await deliver("order.paid", {
      id: `order_detach_${ts}`,
      checkout_id: sessionId,
      customer_id: polar.sessions.get(sessionId)?.input
        ? (polar.sessions.get(sessionId)!.input as Record<string, unknown>).customer_id
        : null,
      product_id: "prod_teams_test",
      seats: 5,
      metadata: { checkout_link: id },
    });
    expect((await read(ownerKey.raw, id)).body.checkout.status).toBe("open");
  });
});
