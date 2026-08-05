import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

if (!ANON_KEY) {
  throw new Error("SUPABASE_ANON_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function callAnonRpc(functionName: string, params?: Record<string, unknown>) {
  const rpc = anon.rpc.bind(anon) as unknown as (
    name: string,
    functionParams?: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  return rpc(functionName, params);
}

const TEST_PASSWORD = "TestPassword123!";
const ts = Date.now();

// Team billing is plan-independent: every user below stays on the free plan.
// Case 5 depends on that — cleanup_free_user_requests only touches free users.
const OWNER_EMAIL = `test-tl-owner-${ts}@webhooks-test.local`;
const MEMBER_EMAIL = `test-tl-member-${ts}@webhooks-test.local`;
const SECOND_MEMBER_EMAIL = `test-tl-member2-${ts}@webhooks-test.local`;

let ownerId: string;
let memberId: string;
let secondMemberId: string;

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
const createdEndpointIds: string[] = [];

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

/** team_invites is deny-all under RLS; the service-role client bypasses it. */
async function createPendingInvite(
  teamId: string,
  invitedBy: string,
  invitedUserId: string,
  invitedEmail: string
): Promise<string> {
  const { data, error } = await admin
    .from("team_invites")
    .insert({
      team_id: teamId,
      invited_by: invitedBy,
      invited_email: invitedEmail,
      invited_user_id: invitedUserId,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function acceptInviteRpc(userId: string, inviteId: string, seatId: string | null) {
  const { data, error } = await admin.rpc("accept_team_invite", {
    p_user_id: userId,
    p_invite_id: inviteId,
    p_seat_id: seatId,
  });
  if (error) throw error;
  return data as { status: string };
}

async function getInviteStatus(inviteId: string): Promise<string> {
  const { data, error } = await admin
    .from("team_invites")
    .select("status")
    .eq("id", inviteId)
    .single();
  if (error) throw error;
  return (data as { status: string }).status;
}

async function getMembership(teamId: string, userId: string) {
  const { data, error } = await admin
    .from("team_members")
    .select("id, role, polar_seat_id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; role: string; polar_seat_id: string | null } | null;
}

async function getTeam(teamId: string) {
  const { data, error } = await admin
    .from("teams")
    .select(
      "id, subscription_status, seats, requests_used, request_limit, period_start, period_end, cancel_at_period_end, polar_subscription_id"
    )
    .eq("id", teamId)
    .single();
  if (error) throw error;
  return data as {
    id: string;
    subscription_status: string | null;
    seats: number;
    requests_used: number;
    request_limit: number;
    period_start: string | null;
    period_end: string | null;
    cancel_at_period_end: boolean;
    polar_subscription_id: string | null;
  };
}

async function activateTeam(
  teamId: string,
  seats: number,
  overrides: Record<string, unknown> = {}
) {
  const { error } = await admin
    .from("teams")
    .update({
      subscription_status: "active",
      seats,
      request_limit: seats * 100_000,
      requests_used: 0,
      period_start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      cancel_at_period_end: false,
      polar_subscription_id: `sub_test_${teamId.slice(0, 8)}`,
      ...overrides,
    })
    .eq("id", teamId);
  if (error) throw error;
}

async function runBillingResets() {
  const { data, error } = await admin.rpc("process_billing_period_resets");
  if (error) throw error;
  const rows = (data ?? []) as { processed: number; downgraded: number; renewed: number }[];
  return rows[0] ?? { processed: 0, downgraded: 0, renewed: 0 };
}

async function insertRequest(endpointId: string, userId: string, teamId: string | null, at: Date) {
  const { data, error } = await admin
    .from("requests")
    .insert({
      endpoint_id: endpointId,
      user_id: userId,
      team_id: teamId,
      method: "POST",
      path: teamId ? "/team" : "/personal",
      headers: { "content-type": "application/json" },
      body: '{"n":1}',
      query_params: {},
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 7,
      received_at: at.toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function requestExists(requestId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("requests")
    .select("id")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

beforeAll(async () => {
  ownerId = await createTestUser(OWNER_EMAIL, "TL Owner");
  memberId = await createTestUser(MEMBER_EMAIL, "TL Member");
  secondMemberId = await createTestUser(SECOND_MEMBER_EMAIL, "TL Second Member");
});

afterAll(async () => {
  if (createdEndpointIds.length > 0) {
    await admin.from("requests").delete().in("endpoint_id", createdEndpointIds);
    await admin.from("team_endpoints").delete().in("endpoint_id", createdEndpointIds);
    await admin.from("endpoints").delete().in("id", createdEndpointIds);
  }
  if (createdTeamIds.length > 0) {
    await admin.from("teams").delete().in("id", createdTeamIds);
  }
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

describe("accept_team_invite seat cap", () => {
  it("refuses to seat a member on a team without an active subscription", async () => {
    const teamId = await createTestTeam(ownerId, `TL Inactive ${ts}`);
    const inviteId = await createPendingInvite(teamId, ownerId, memberId, MEMBER_EMAIL);

    const result = await acceptInviteRpc(memberId, inviteId, "seat_inactive");

    expect(result.status).toBe("inactive");
    expect(await getInviteStatus(inviteId)).toBe("pending");
    expect(await getMembership(teamId, memberId)).toBeNull();
  });

  it("seats members up to the seat count and rolls the overflow invite back", async () => {
    const teamId = await createTestTeam(ownerId, `TL Seats ${ts}`);
    // 2 seats, and the owner's membership already occupies one of them.
    await activateTeam(teamId, 2);

    const firstInvite = await createPendingInvite(teamId, ownerId, memberId, MEMBER_EMAIL);
    const seatId = `seat_${ts}_first`;
    const first = await acceptInviteRpc(memberId, firstInvite, seatId);

    expect(first.status).toBe("accepted");
    expect(await getInviteStatus(firstInvite)).toBe("accepted");
    const membership = await getMembership(teamId, memberId);
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe("member");
    expect(membership!.polar_seat_id).toBe(seatId);

    // Third body, only two seats — must be rejected and left retryable.
    const secondInvite = await createPendingInvite(
      teamId,
      ownerId,
      secondMemberId,
      SECOND_MEMBER_EMAIL
    );
    const second = await acceptInviteRpc(secondMemberId, secondInvite, `seat_${ts}_second`);

    expect(second.status).toBe("full");
    expect(await getInviteStatus(secondInvite)).toBe("pending");
    expect(await getMembership(teamId, secondMemberId)).toBeNull();
  });
});

describe("process_billing_period_resets for teams", () => {
  it("renews an active team at period end", async () => {
    const teamId = await createTestTeam(ownerId, `TL Renew ${ts}`);
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await activateTeam(teamId, 3, {
      requests_used: 123,
      cancel_at_period_end: false,
      period_start: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      period_end: expiredAt,
    });

    const result = await runBillingResets();
    expect(result.processed).toBe(result.downgraded + result.renewed);

    const team = await getTeam(teamId);
    expect(team.subscription_status).toBe("active");
    expect(team.requests_used).toBe(0);
    expect(team.request_limit).toBe(300_000);
    expect(team.cancel_at_period_end).toBe(false);
    expect(team.polar_subscription_id).toBeTruthy();
    expect(Date.parse(team.period_start!)).toBe(Date.parse(expiredAt));

    const delta = Date.parse(team.period_end!) - Date.parse(expiredAt);
    expect(delta).toBeGreaterThanOrEqual(29 * 24 * 60 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);
  });

  it("deactivates a team that canceled at period end", async () => {
    const teamId = await createTestTeam(ownerId, `TL Cancel ${ts}`);
    await activateTeam(teamId, 2, {
      requests_used: 50,
      cancel_at_period_end: true,
      period_start: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      period_end: new Date(Date.now() - 60_000).toISOString(),
    });

    await runBillingResets();

    const team = await getTeam(teamId);
    expect(team.subscription_status).toBeNull();
    expect(team.polar_subscription_id).toBeNull();
    expect(team.cancel_at_period_end).toBe(false);
    expect(team.period_start).toBeNull();
    expect(team.period_end).toBeNull();
  });

  it("leaves an active team with a future period alone", async () => {
    const teamId = await createTestTeam(ownerId, `TL Future ${ts}`);
    await activateTeam(teamId, 1, { requests_used: 7 });
    const before = await getTeam(teamId);

    await runBillingResets();

    const after = await getTeam(teamId);
    expect(after.subscription_status).toBe("active");
    expect(after.requests_used).toBe(7);
    expect(Date.parse(after.period_end!)).toBe(Date.parse(before.period_end!));
  });
});

describe("cleanup_free_user_requests team carve-out", () => {
  it("deletes stale personal requests but spares team-billed ones", async () => {
    const teamId = await createTestTeam(ownerId, `TL Retention ${ts}`);
    const endpoint = await createEndpointForUser({ userId: ownerId, name: "TL retention" });
    createdEndpointIds.push(endpoint.id);

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const personalRequestId = await insertRequest(endpoint.id, ownerId, null, tenDaysAgo);
    const teamRequestId = await insertRequest(endpoint.id, ownerId, teamId, tenDaysAgo);

    const { error } = await admin.rpc("cleanup_free_user_requests");
    if (error) throw error;

    expect(await requestExists(personalRequestId)).toBe(false);
    expect(await requestExists(teamRequestId)).toBe(true);
  });
});

// `create or replace` preserves a function's existing ACL, so every function
// this migration re-creates needs its service-role-only grant asserted, not
// assumed. Mirrors supabase-cleanup.test.ts's check on the ephemeral cleanup RPC.
describe("service-role-only grants", () => {
  it("does not allow anonymous clients to invoke the free-user retention rpc", async () => {
    const { data, error } = await callAnonRpc("cleanup_free_user_requests");

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("does not allow anonymous clients to invoke the billing reset rpc", async () => {
    const { data, error } = await callAnonRpc("process_billing_period_resets");

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("does not allow anonymous clients to invoke the invite acceptance rpc", async () => {
    const { data, error } = await callAnonRpc("accept_team_invite", {
      p_user_id: ownerId,
      p_invite_id: ownerId,
      p_seat_id: null,
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});
