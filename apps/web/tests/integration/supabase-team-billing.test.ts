import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { TEAM_SEAT_REQUEST_LIMIT, applyTeamPolarWebhookEvent } from "@/lib/supabase/team-billing";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_PASSWORD = "TestPassword123!";
const ts = Date.now();

// Team billing is plan-independent — no user below is upgraded to Pro.
const OWNER_EMAIL = `test-tb-owner-${ts}@webhooks-test.local`;
const MEMBER_EMAIL = `test-tb-member-${ts}@webhooks-test.local`;

let ownerId: string;
let memberId: string;

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];

async function createTestUser(email: string, name: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (error) throw error;
  const userId = data.user!.id;
  createdUserIds.push(userId);
  return userId;
}

async function createTestTeam(userId: string, name: string): Promise<string> {
  const { data, error } = await admin.rpc("create_team_with_owner", {
    p_user_id: userId,
    p_name: name,
  });
  if (error) throw error;
  const team = data as { id?: string; error?: string };
  if (!team.id) throw new Error(`create_team_with_owner failed: ${team.error}`);
  createdTeamIds.push(team.id);
  return team.id;
}

/** team_members is deny-all under RLS; the service-role client bypasses it. */
async function addMember(teamId: string, userId: string, polarSeatId: string | null = null) {
  const { error } = await admin.from("team_members").insert({
    team_id: teamId,
    user_id: userId,
    role: "member",
    polar_seat_id: polarSeatId,
  });
  if (error) throw error;
}

async function getTeam(teamId: string) {
  const { data, error } = await admin
    .from("teams")
    .select(
      "id, polar_customer_id, polar_subscription_id, subscription_status, seats, requests_used, request_limit, period_start, period_end, cancel_at_period_end"
    )
    .eq("id", teamId)
    .single();
  if (error) throw error;
  return data;
}

async function getMembership(teamId: string, userId: string) {
  const { data, error } = await admin
    .from("team_members")
    .select("id, role, polar_seat_id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function setRequestsUsed(teamId: string, used: number) {
  const { error } = await admin.from("teams").update({ requests_used: used }).eq("id", teamId);
  if (error) throw error;
}

/** A team with an owner membership plus one member membership. */
async function createSeatTeam(name: string, polarSeatId: string | null = null) {
  const teamId = await createTestTeam(ownerId, name);
  await addMember(teamId, memberId, polarSeatId);
  return teamId;
}

beforeAll(async () => {
  ownerId = await createTestUser(OWNER_EMAIL, "TB Owner");
  memberId = await createTestUser(MEMBER_EMAIL, "TB Member");
});

afterAll(async () => {
  if (createdTeamIds.length > 0) {
    await admin.from("teams").delete().in("id", createdTeamIds);
  }
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

describe("applyTeamPolarWebhookEvent — subscription lifecycle", () => {
  let teamId: string;
  const periodStart = new Date(Date.now() - 60_000);
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    teamId = await createTestTeam(ownerId, `TB Lifecycle ${ts}`);
  });

  it("activates the team on subscription.created", async () => {
    await applyTeamPolarWebhookEvent("subscription.created", teamId, {
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      seats: 5,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });

    const team = await getTeam(teamId);
    expect(team.polar_subscription_id).toBe("sub_1");
    expect(team.polar_customer_id).toBe("cus_1");
    expect(team.subscription_status).toBe("active");
    expect(team.seats).toBe(5);
    expect(team.request_limit).toBe(5 * TEAM_SEAT_REQUEST_LIMIT);
    expect(team.cancel_at_period_end).toBe(false);
    expect(new Date(team.period_start!).toISOString()).toBe(periodStart.toISOString());
    expect(new Date(team.period_end!).toISOString()).toBe(periodEnd.toISOString());
  });

  it("resizes the pool on subscription.updated without touching usage", async () => {
    await setRequestsUsed(teamId, 1234);

    await applyTeamPolarWebhookEvent("subscription.updated", teamId, {
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      seats: 8,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });

    const team = await getTeam(teamId);
    expect(team.seats).toBe(8);
    expect(team.request_limit).toBe(800_000);
    expect(team.requests_used).toBe(1234);
    expect(team.subscription_status).toBe("active");
  });

  it("flags a scheduled cancellation on subscription.canceled", async () => {
    await applyTeamPolarWebhookEvent("subscription.canceled", teamId, {
      id: "sub_1",
      customerId: "cus_1",
    });

    const team = await getTeam(teamId);
    expect(team.cancel_at_period_end).toBe(true);
    expect(team.subscription_status).toBe("canceled");
    expect(team.request_limit).toBe(800_000);
  });

  it("clears the cancellation flag on subscription.uncanceled", async () => {
    await applyTeamPolarWebhookEvent("subscription.uncanceled", teamId, {
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
    });

    const team = await getTeam(teamId);
    expect(team.cancel_at_period_end).toBe(false);
    expect(team.subscription_status).toBe("active");
  });

  it("deactivates the team on subscription.revoked but retains seats and usage", async () => {
    await applyTeamPolarWebhookEvent("subscription.revoked", teamId, {
      id: "sub_1",
      customerId: "cus_1",
    });

    const team = await getTeam(teamId);
    expect(team.subscription_status).toBeNull();
    expect(team.polar_subscription_id).toBeNull();
    expect(team.cancel_at_period_end).toBe(false);
    expect(team.period_start).toBeNull();
    expect(team.period_end).toBeNull();
    expect(team.seats).toBe(8);
    expect(team.requests_used).toBe(1234);
  });

  it("resets pooled usage when a different subscription id arrives", async () => {
    const newStart = new Date();
    const newEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await applyTeamPolarWebhookEvent("subscription.created", teamId, {
      id: "sub_2",
      customerId: "cus_1",
      status: "active",
      seats: 3,
      currentPeriodStart: newStart,
      currentPeriodEnd: newEnd,
      cancelAtPeriodEnd: false,
    });

    const team = await getTeam(teamId);
    expect(team.polar_subscription_id).toBe("sub_2");
    expect(team.subscription_status).toBe("active");
    expect(team.seats).toBe(3);
    expect(team.request_limit).toBe(3 * TEAM_SEAT_REQUEST_LIMIT);
    expect(team.requests_used).toBe(0);
    expect(new Date(team.period_end!).toISOString()).toBe(newEnd.toISOString());
  });
});

describe("applyTeamPolarWebhookEvent — seat events", () => {
  it("removes the seated member on customer_seat.revoked but never the owner", async () => {
    const teamId = await createSeatTeam(`TB Seat Revoke ${ts}`, "seat_member");

    await applyTeamPolarWebhookEvent("customer_seat.revoked", teamId, {
      id: "seat_member",
      seatMetadata: { userId: memberId, teamId },
    });

    expect(await getMembership(teamId, memberId)).toBeNull();

    await applyTeamPolarWebhookEvent("customer_seat.revoked", teamId, {
      id: "seat_owner",
      seatMetadata: { userId: ownerId, teamId },
    });

    const ownerMembership = await getMembership(teamId, ownerId);
    expect(ownerMembership).not.toBeNull();
    expect(ownerMembership!.role).toBe("owner");
  });

  it("falls back to the seat email when the seat carries no user metadata", async () => {
    const teamId = await createSeatTeam(`TB Seat Email ${ts}`);

    await applyTeamPolarWebhookEvent("customer_seat.revoked", teamId, {
      id: "seat_email",
      customerEmail: MEMBER_EMAIL,
    });

    expect(await getMembership(teamId, memberId)).toBeNull();
  });

  it("stores the seat id on customer_seat.claimed without overwriting an existing one", async () => {
    const teamId = await createSeatTeam(`TB Seat Claim ${ts}`);

    await applyTeamPolarWebhookEvent("customer_seat.claimed", teamId, {
      id: "seat_1",
      customerEmail: MEMBER_EMAIL,
    });

    expect((await getMembership(teamId, memberId))!.polar_seat_id).toBe("seat_1");

    await applyTeamPolarWebhookEvent("customer_seat.claimed", teamId, {
      id: "seat_2",
      seatMetadata: { userId: memberId },
    });

    expect((await getMembership(teamId, memberId))!.polar_seat_id).toBe("seat_1");
  });
});
