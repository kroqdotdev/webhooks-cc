/**
 * Migration 00108: teams staff own are live on Team Business without a
 * Polar subscription, kept there by the database, rolled forward by the
 * period job, suspended again when their owner stops being staff, and
 * refused cleanly by every path that would ask Polar.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";

// Nothing here may reach Polar: a call fails the test.
const polarCalled = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/polar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/polar")>();
  return {
    ...actual,
    createPolarClient: () => {
      polarCalled.count += 1;
      throw new Error("Polar must not be called for a complimentary team");
    },
  };
});

import { createTeam, deleteTeam, listTeamsForUser } from "@/lib/supabase/teams-crud";
import {
  cancelTeamSubscription,
  changeTeamPlan,
  createTeamCheckout,
  createTeamCustomerPortal,
  quoteTeamPlanChange,
  quoteTeamSeatChange,
  updateTeamSeats,
} from "@/lib/supabase/team-billing";
import { createOneTimeBlocksCheckout, getCapacityState } from "@/lib/supabase/capacity-billing";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient<Database>(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
const userIds: string[] = [];
const COMPLIMENTARY = "This team is complimentary (staff) and has no subscription to change";

async function createUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-staff-team-${label}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userIds.push(data.user.id);
  return data.user.id;
}

async function team(id: string) {
  const { data, error } = await admin.from("teams").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function newTeam(ownerId: string, name: string): Promise<string> {
  const created = await createTeam(ownerId, name);
  if ("error" in created) throw new Error(created.error);
  return created.id;
}

let staffId: string;
let otherId: string;
let perSeat: number;

beforeAll(async () => {
  // Checkouts are checked against the products first; the dev env may name none.
  vi.stubEnv("POLAR_TEAM_BUSINESS_MONTHLY_PRODUCT_ID", "prod_team_business_test");
  for (const name of [
    "POLAR_REQUEST_BLOCKS_PRODUCT_ID",
    "POLAR_MONTHLY_BLOCKS_PRODUCT_ID",
    "POLAR_MONTHLY_BLOCKS_ADD_PRODUCT_ID",
    "POLAR_OVERAGE_PRODUCT_ID",
  ]) {
    vi.stubEnv(name, `prod_${name.toLowerCase()}_test`);
  }
  staffId = await createUser("staff");
  otherId = await createUser("other");
  const { error } = await admin.from("staff").insert({ user_id: staffId });
  if (error) throw error;
  const { data, error: entitlementsError } = await admin
    .from("plan_entitlements")
    .select("request_limit, pool_requests")
    .eq("key", "team_business")
    .single();
  if (entitlementsError) throw entitlementsError;
  perSeat = data.request_limit;
  expect(data.pool_requests).toBe(0);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await admin.from("staff").delete().in("user_id", userIds);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

describe("a team staff create", () => {
  let teamId: string;

  it("is live on Team Business at once, with 10 seats and no checkout", async () => {
    const created = await createTeam(staffId, `Staff team ${ts}`);
    if ("error" in created) throw new Error(created.error);
    teamId = created.id;
    expect(created).toMatchObject({
      suspended: false,
      subscriptionStatus: "active",
      business: true,
      billingInterval: "month",
      seats: 10,
      requestLimit: 10 * perSeat,
      cancelAtPeriodEnd: false,
      complimentary: true,
    });

    const row = await team(teamId);
    expect(row.polar_subscription_id).toBeNull();
    expect(row.billing_period_end).toBeNull();
    expect(Date.parse(row.period_end!) - Date.parse(row.period_start!)).toBe(30 * 86_400_000);

    const [listed] = (await listTeamsForUser(staffId)).filter((t) => t.id === teamId);
    expect(listed.complimentary).toBe(true);
  });

  it("stays there whatever a write tries", async () => {
    const { error } = await admin
      .from("teams")
      .update({
        subscription_status: null,
        business: false,
        seats: 3,
        cancel_at_period_end: true,
        pending_plan: "team",
        pending_interval: "month",
      })
      .eq("id", teamId);
    expect(error).toBeNull();
    const row = await team(teamId);
    expect(row).toMatchObject({
      subscription_status: "active",
      business: true,
      seats: 10,
      cancel_at_period_end: false,
      pending_plan: null,
      request_limit: 10 * perSeat,
    });
  });

  it("rolls its quota period forward in the period job, never ending it", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const { error } = await admin
      .from("teams")
      .update({
        period_start: new Date(Date.now() - 31 * 86_400_000).toISOString(),
        period_end: past,
        requests_used: 1234,
      })
      .eq("id", teamId);
    expect(error).toBeNull();

    // Not in the generated types (no client calls it); the cron job does.
    const { error: resetError } = await admin.rpc("process_billing_period_resets" as never);
    expect(resetError).toBeNull();

    const row = await team(teamId);
    expect(row.subscription_status).toBe("active");
    expect(row.requests_used).toBe(0);
    expect(Date.parse(row.period_end!)).toBeGreaterThan(Date.now());
    expect(Date.parse(row.period_start!)).toBe(Date.parse(past));
  });

  it("refuses every billing change that would ask Polar, with a clear reason", async () => {
    polarCalled.count = 0;
    await expect(cancelTeamSubscription(staffId, teamId)).rejects.toMatchObject({
      code: "no_subscription",
      message: COMPLIMENTARY,
    });
    await expect(updateTeamSeats(staffId, teamId, 12)).rejects.toMatchObject({
      message: COMPLIMENTARY,
    });
    await expect(quoteTeamSeatChange(staffId, teamId, 12)).rejects.toMatchObject({
      message: COMPLIMENTARY,
    });
    await expect(changeTeamPlan(staffId, teamId, "team", "month")).rejects.toMatchObject({
      message: COMPLIMENTARY,
    });
    await expect(quoteTeamPlanChange(staffId, teamId, "team", "month")).rejects.toMatchObject({
      message: COMPLIMENTARY,
    });
    await expect(createTeamCheckout(staffId, teamId, 5, "team_business")).rejects.toMatchObject({
      code: "already_subscribed",
      message: "This team is complimentary (staff) and needs no subscription",
    });
    await expect(createTeamCustomerPortal(staffId, teamId)).rejects.toMatchObject({
      code: "no_customer",
      message: "This team is complimentary (staff) and has no invoices",
    });
    await expect(
      createOneTimeBlocksCheckout({ kind: "team", teamId }, staffId, 1)
    ).rejects.toMatchObject({
      code: "plan_required",
      message: "This team is complimentary (staff) and has no subscription to add to",
    });
    await expect(getCapacityState({ kind: "team", teamId })).resolves.toMatchObject({
      eligible: false,
      noSubscription: true,
    });
    // Team Business's pages and domains are the team's; only their add-ons are not offered.
    await expect(getCapacityState({ kind: "team", teamId }, "pages")).resolves.toMatchObject({
      eligible: false,
      noSubscription: true,
    });
    await expect(getCapacityState({ kind: "team", teamId }, "domains")).resolves.toMatchObject({
      eligible: false,
      noSubscription: true,
    });
    expect(polarCalled.count).toBe(0);
  });

  it("is suspended when its owner stops being staff, and live again when made staff", async () => {
    await admin.from("staff").delete().eq("user_id", staffId);
    const suspended = await team(teamId);
    expect(suspended).toMatchObject({
      subscription_status: null,
      business: false,
      seats: 0,
      request_limit: 0,
      period_end: null,
    });
    const [listed] = (await listTeamsForUser(staffId)).filter((t) => t.id === teamId);
    expect(listed).toMatchObject({ suspended: true, complimentary: false });

    const { error } = await admin.from("staff").insert({ user_id: staffId });
    expect(error).toBeNull();
    expect(await team(teamId)).toMatchObject({
      subscription_status: "active",
      business: true,
      seats: 10,
      request_limit: 10 * perSeat,
    });
  });

  it("is suspended when ownership moves to someone who is not staff", async () => {
    const moved = await newTeam(staffId, `Moved team ${ts}`);
    await admin.from("team_members").insert({ team_id: moved, user_id: otherId, role: "member" });
    await admin
      .from("team_members")
      .update({ role: "member" })
      .eq("team_id", moved)
      .eq("user_id", staffId);
    await admin
      .from("team_members")
      .update({ role: "owner" })
      .eq("team_id", moved)
      .eq("user_id", otherId);
    expect((await team(moved)).subscription_status).toBeNull();
    await admin.from("teams").delete().eq("id", moved);
  });

  it("is suspended when the staff user it was moved to is deleted", async () => {
    // The cascade can remove the staff row before the owner row, so the
    // owner row going away must suspend the team on its own.
    const staffB = await createUser("staff-b");
    const { error: staffError } = await admin.from("staff").insert({ user_id: staffB });
    if (staffError) throw staffError;
    const moved = await newTeam(otherId, `Moved to staff ${ts}`);
    expect((await team(moved)).subscription_status).toBeNull();
    await admin.from("team_members").insert({ team_id: moved, user_id: staffB, role: "member" });
    await admin
      .from("team_members")
      .update({ role: "member" })
      .eq("team_id", moved)
      .eq("user_id", otherId);
    await admin
      .from("team_members")
      .update({ role: "owner" })
      .eq("team_id", moved)
      .eq("user_id", staffB);
    expect((await team(moved)).subscription_status).toBe("active");
    const { error: deleteError } = await admin.auth.admin.deleteUser(staffB);
    if (deleteError) throw deleteError;
    expect(await team(moved)).toMatchObject({ subscription_status: null, seats: 0 });
    await admin.from("teams").delete().eq("id", moved);
  });

  it("can be deleted, with nothing to revoke", async () => {
    polarCalled.count = 0;
    await expect(deleteTeam(staffId, teamId)).resolves.toBe(true);
    expect(polarCalled.count).toBe(0);
    const { data } = await admin.from("teams").select("id").eq("id", teamId).maybeSingle();
    expect(data).toBeNull();
  });
});

describe("a team anyone else creates", () => {
  it("starts suspended, as before", async () => {
    const created = await createTeam(otherId, `Other team ${ts}`);
    if ("error" in created) throw new Error(created.error);
    expect(created).toMatchObject({
      suspended: true,
      subscriptionStatus: null,
      seats: 0,
      complimentary: false,
    });
    await admin.from("teams").delete().eq("id", created.id);
  });
});
