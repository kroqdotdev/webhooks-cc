import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import type { Json } from "@/lib/supabase/database";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import {
  TEAM_SEAT_REQUEST_LIMIT,
  applyTeamPolarWebhookEvent,
  claimPendingCheckoutSlot,
} from "@/lib/supabase/team-billing";

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
// create_team_with_owner caps ownership at 10 teams per user, so the review
// regression tests seat their teams under a second owner.
const ALT_OWNER_EMAIL = `test-tb-owner2-${ts}@webhooks-test.local`;

// `teams_polar_customer` is a unique index: no two teams — including leftovers
// from an interrupted run — may carry the same Polar customer id.
const LIFECYCLE_CUSTOMER_ID = `cus_lifecycle_${ts}`;

let ownerId: string;
let memberId: string;
let altOwnerId: string;

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
  altOwnerId = await createTestUser(ALT_OWNER_EMAIL, "TB Owner Two");
});

afterAll(async () => {
  if (createdTeamIds.length > 0) {
    await admin.from("teams").delete().in("id", createdTeamIds);
  }
  if (createdEndpointIds.length > 0) {
    await admin.from("endpoints").delete().in("id", createdEndpointIds);
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
      customerId: LIFECYCLE_CUSTOMER_ID,
      status: "active",
      seats: 5,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });

    const team = await getTeam(teamId);
    expect(team.polar_subscription_id).toBe("sub_1");
    expect(team.polar_customer_id).toBe(LIFECYCLE_CUSTOMER_ID);
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
      customerId: LIFECYCLE_CUSTOMER_ID,
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
      customerId: LIFECYCLE_CUSTOMER_ID,
    });

    const team = await getTeam(teamId);
    expect(team.cancel_at_period_end).toBe(true);
    expect(team.subscription_status).toBe("canceled");
    expect(team.request_limit).toBe(800_000);
  });

  it("clears the cancellation flag on subscription.uncanceled", async () => {
    await applyTeamPolarWebhookEvent("subscription.uncanceled", teamId, {
      id: "sub_1",
      customerId: LIFECYCLE_CUSTOMER_ID,
      status: "active",
    });

    const team = await getTeam(teamId);
    expect(team.cancel_at_period_end).toBe(false);
    expect(team.subscription_status).toBe("active");
  });

  it("deactivates the team on subscription.revoked but retains seats and usage", async () => {
    await applyTeamPolarWebhookEvent("subscription.revoked", teamId, {
      id: "sub_1",
      customerId: LIFECYCLE_CUSTOMER_ID,
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
      customerId: LIFECYCLE_CUSTOMER_ID,
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

describe("applyTeamPolarWebhookEvent — stale subscription events", () => {
  const periodStart = new Date(Date.now() - 60_000);
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  async function activatedTeam(
    name: string,
    subscriptionId: string,
    customerId: string,
    owner = ownerId
  ) {
    const teamId = await createTestTeam(owner, name);
    await applyTeamPolarWebhookEvent("subscription.created", teamId, {
      id: subscriptionId,
      customerId,
      status: "active",
      seats: 8,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });
    return teamId;
  }

  it("keeps a revoked team deactivated when a late cancel event arrives", async () => {
    const customerId = `cus_stale_revoked_${ts}`;
    const teamId = await activatedTeam(`TB Stale Revoked ${ts}`, "sub_stale_1", customerId);

    await applyTeamPolarWebhookEvent("subscription.revoked", teamId, {
      id: "sub_stale_1",
      customerId,
    });

    // Polar retries: a `canceled` (and later an `uncanceled`) for the very
    // subscription that was just revoked. Neither may resurrect the pool gate.
    await applyTeamPolarWebhookEvent("subscription.canceled", teamId, {
      id: "sub_stale_1",
      customerId,
    });

    let team = await getTeam(teamId);
    expect(team.subscription_status).toBeNull();
    expect(team.cancel_at_period_end).toBe(false);

    await applyTeamPolarWebhookEvent("subscription.uncanceled", teamId, {
      id: "sub_stale_1",
      customerId,
      status: "active",
    });

    team = await getTeam(teamId);
    expect(team.subscription_status).toBeNull();
    expect(team.period_end).toBeNull();
  });

  it("ignores cancel events belonging to a different subscription", async () => {
    const customerId = `cus_stale_mismatch_${ts}`;
    const teamId = await activatedTeam(`TB Stale Mismatch ${ts}`, "sub_stale_2", customerId);

    await applyTeamPolarWebhookEvent("subscription.canceled", teamId, {
      id: "sub_previous",
      customerId,
    });

    const team = await getTeam(teamId);
    expect(team.subscription_status).toBe("active");
    expect(team.cancel_at_period_end).toBe(false);
  });

  it("resets pooled usage when a renewal advances the period on the same subscription", async () => {
    const customerId = `cus_renewal_${ts}`;
    const teamId = await activatedTeam(`TB Renewal ${ts}`, "sub_renewal", customerId, altOwnerId);
    await setRequestsUsed(teamId, 4321);

    // Polar renewals keep the subscription id and only advance the period
    // bounds; the period transition is the one reset signal, and the cron
    // fallback cannot fire because this write moves period_end into the future.
    const renewedStart = periodEnd;
    const renewedEnd = new Date(periodEnd.getTime() + 30 * 24 * 60 * 60 * 1000);
    await applyTeamPolarWebhookEvent("subscription.updated", teamId, {
      id: "sub_renewal",
      customerId,
      status: "active",
      seats: 8,
      currentPeriodStart: renewedStart,
      currentPeriodEnd: renewedEnd,
      cancelAtPeriodEnd: false,
    });

    const team = await getTeam(teamId);
    expect(team.requests_used).toBe(0);
    expect(team.subscription_status).toBe("active");
    expect(new Date(team.period_start!).toISOString()).toBe(renewedStart.toISOString());
    expect(new Date(team.period_end!).toISOString()).toBe(renewedEnd.toISOString());
  });

  it("keeps stored period bounds and usage when a stale update arrives out of order", async () => {
    const customerId = `cus_stale_period_${ts}`;
    const teamId = await activatedTeam(
      `TB Stale Period ${ts}`,
      "sub_stale_period",
      customerId,
      altOwnerId
    );
    await setRequestsUsed(teamId, 777);

    const staleStart = new Date(periodStart.getTime() - 30 * 24 * 60 * 60 * 1000);
    await applyTeamPolarWebhookEvent("subscription.updated", teamId, {
      id: "sub_stale_period",
      customerId,
      status: "active",
      seats: 8,
      currentPeriodStart: staleStart,
      currentPeriodEnd: periodStart,
      cancelAtPeriodEnd: false,
    });

    const team = await getTeam(teamId);
    expect(team.requests_used).toBe(777);
    expect(new Date(team.period_start!).toISOString()).toBe(periodStart.toISOString());
    expect(new Date(team.period_end!).toISOString()).toBe(periodEnd.toISOString());
  });

  it("ignores a revoked event belonging to a replaced subscription", async () => {
    const customerId = `cus_revoked_mismatch_${ts}`;
    const teamId = await activatedTeam(
      `TB Revoked Mismatch ${ts}`,
      "sub_current",
      customerId,
      altOwnerId
    );

    // A delayed revoke for the subscription this team already replaced must
    // not deactivate the current, paying one.
    await applyTeamPolarWebhookEvent("subscription.revoked", teamId, {
      id: "sub_previous",
      customerId,
    });

    const team = await getTeam(teamId);
    expect(team.subscription_status).toBe("active");
    expect(team.polar_subscription_id).toBe("sub_current");
    expect(team.period_end).not.toBeNull();
  });

  it("keeps the team active when a live event carries an unrecognized status", async () => {
    const customerId = `cus_unknown_status_${ts}`;
    const teamId = await activatedTeam(
      `TB Unknown Status ${ts}`,
      "sub_unknown",
      customerId,
      altOwnerId
    );

    // subscription_status null is the deactivation gate, so an unknown status
    // value on a live-subscription event must never null it.
    await applyTeamPolarWebhookEvent("subscription.updated", teamId, {
      id: "sub_unknown",
      customerId,
      status: "some_future_status",
      seats: 8,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });

    const team = await getTeam(teamId);
    expect(team.subscription_status).toBe("active");
  });

  it("ignores subscription events for a foreign subscription while another is live", async () => {
    const customerId = `cus_foreign_${ts}`;
    const teamId = await activatedTeam(`TB Foreign Sub ${ts}`, "sub_live", customerId, altOwnerId);

    // A double-checkout's second subscription (or a stale cross-subscription
    // event) must never overwrite the subscription the team actually tracks.
    await applyTeamPolarWebhookEvent("subscription.updated", teamId, {
      id: "sub_foreign",
      customerId,
      status: "active",
      seats: 3,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });

    const team = await getTeam(teamId);
    expect(team.polar_subscription_id).toBe("sub_live");
    expect(team.seats).toBe(8);
  });

  it("keeps a revoked team deactivated on stale updated/active, reactivates on created", async () => {
    const customerId = `cus_postrevoke_${ts}`;
    const teamId = await activatedTeam(`TB Post Revoke ${ts}`, "sub_gone", customerId, altOwnerId);

    await applyTeamPolarWebhookEvent("subscription.revoked", teamId, { id: "sub_gone", customerId });

    // Stale deliveries for the revoked subscription must not re-open the pool:
    // the cron would renew a reactivated team unbilled forever.
    await applyTeamPolarWebhookEvent("subscription.updated", teamId, {
      id: "sub_gone",
      customerId,
      status: "active",
      seats: 8,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });
    await applyTeamPolarWebhookEvent("subscription.active", teamId, {
      id: "sub_gone",
      customerId,
      status: "active",
    });

    let team = await getTeam(teamId);
    expect(team.subscription_status).toBeNull();
    expect(team.polar_subscription_id).toBeNull();

    // A genuinely new subscription still activates.
    await applyTeamPolarWebhookEvent("subscription.created", teamId, {
      id: "sub_next",
      customerId,
      status: "active",
      seats: 2,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
    });

    team = await getTeam(teamId);
    expect(team.subscription_status).toBe("active");
    expect(team.polar_subscription_id).toBe("sub_next");
    expect(team.requests_used).toBe(0);
  });

  it("activates with a one-seat pool when the payload carries no seat count", async () => {
    const teamId = await createTestTeam(ownerId, `TB Seatless ${ts}`);

    await applyTeamPolarWebhookEvent("subscription.created", teamId, {
      id: "sub_seatless",
      customerId: `cus_seatless_${ts}`,
      status: "active",
      seats: null,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });

    const team = await getTeam(teamId);
    expect(team.subscription_status).toBe("active");
    expect(team.seats).toBeGreaterThanOrEqual(1);
    expect(team.request_limit).toBeGreaterThanOrEqual(TEAM_SEAT_REQUEST_LIMIT);
  });
});

describe("pending-checkout claim", () => {
  // Pins the PostgREST filter syntax claimPendingCheckoutSlot relies on
  // (jsonb ->> paths and quoted values inside or()) against the real server.
  let teamId: string;

  beforeAll(async () => {
    teamId = await createTestTeam(altOwnerId, `TB Claim ${ts}`);
  });

  async function setPending(value: Json | null) {
    const { error } = await admin
      .from("teams")
      .update({ pending_checkout: value })
      .eq("id", teamId);
    if (error) throw error;
  }

  it("claims an empty slot, then refuses while the fresh lease is held", async () => {
    await setPending(null);
    expect(await claimPendingCheckoutSlot(teamId, 3)).toBe(true);
    // Second concurrent-style request for the same seat count: blocked.
    expect(await claimPendingCheckoutSlot(teamId, 3)).toBe(false);
  });

  it("claims over an abandoned lease", async () => {
    await setPending({
      status: "creating",
      seats: 3,
      created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    expect(await claimPendingCheckoutSlot(teamId, 3)).toBe(true);
  });

  it("refuses over an open same-seat session, claims for a different seat count", async () => {
    const session: Json = {
      id: "co_claim",
      url: "https://example.com/checkout",
      seats: 3,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    await setPending(session);
    expect(await claimPendingCheckoutSlot(teamId, 3)).toBe(false);
    await setPending(session);
    expect(await claimPendingCheckoutSlot(teamId, 5)).toBe(true);
  });

  it("claims over an expired session", async () => {
    await setPending({
      id: "co_claim",
      url: "https://example.com/checkout",
      seats: 3,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(await claimPendingCheckoutSlot(teamId, 3)).toBe(true);
  });
});

describe("update_team_seats RPC", () => {
  it("updates seats and pool limit atomically, and refuses to undercut membership", async () => {
    // Two memberships: the alt owner plus one invitee.
    const teamId = await createTestTeam(altOwnerId, `TB Seat RPC ${ts}`);
    await addMember(teamId, memberId);

    const { data: ok, error } = await admin.rpc("update_team_seats", {
      p_team_id: teamId,
      p_seats: 4,
    });
    expect(error).toBeNull();
    expect(ok).toMatchObject({ status: "ok", previous_seats: 0 });

    let team = await getTeam(teamId);
    expect(team.seats).toBe(4);
    expect(team.request_limit).toBe(4 * TEAM_SEAT_REQUEST_LIMIT);

    const { data: refused } = await admin.rpc("update_team_seats", {
      p_team_id: teamId,
      p_seats: 1,
    });
    expect(refused).toMatchObject({ status: "below_members", member_count: 2 });

    team = await getTeam(teamId);
    expect(team.seats).toBe(4);
    expect(team.request_limit).toBe(4 * TEAM_SEAT_REQUEST_LIMIT);
  });

  it("reports a missing team and an out-of-range seat count without writing", async () => {
    const { data: notFound } = await admin.rpc("update_team_seats", {
      p_team_id: crypto.randomUUID(),
      p_seats: 2,
    });
    expect(notFound).toMatchObject({ status: "not_found" });

    const teamId = await createTestTeam(altOwnerId, `TB Seat RPC Bounds ${ts}`);
    const { data: invalid } = await admin.rpc("update_team_seats", {
      p_team_id: teamId,
      p_seats: 0,
    });
    expect(invalid).toMatchObject({ status: "invalid_seats" });

    const team = await getTeam(teamId);
    expect(team.seats).toBe(0);
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

  it("removes the revoked member's endpoint shares along with the membership", async () => {
    const teamId = await createSeatTeam(`TB Seat Share Cleanup ${ts}`, "seat_shared");

    const endpoint = await createEndpointForUser({
      userId: memberId,
      name: "TB Seat Share EP",
    });
    createdEndpointIds.push(endpoint.id);
    const { error: shareError } = await admin.from("team_endpoints").insert({
      team_id: teamId,
      endpoint_id: endpoint.id,
      shared_by: memberId,
    });
    if (shareError) throw shareError;

    await applyTeamPolarWebhookEvent("customer_seat.revoked", teamId, {
      id: "seat_shared",
      seatMetadata: { userId: memberId, teamId },
    });

    expect(await getMembership(teamId, memberId)).toBeNull();

    const { data: shares, error } = await admin
      .from("team_endpoints")
      .select("id")
      .eq("team_id", teamId)
      .eq("shared_by", memberId);
    if (error) throw error;
    expect(shares).toEqual([]);
  });

  it("ignores a revoked event for a seat the member no longer holds", async () => {
    const teamId = await createSeatTeam(`TB Seat Stale Revoke ${ts}`, "seat_replacement");

    // A delayed revoke for the member's old seat must not remove a member who
    // has since been re-seated under a new seat id.
    await applyTeamPolarWebhookEvent("customer_seat.revoked", teamId, {
      id: "seat_old",
      seatMetadata: { userId: memberId, teamId },
    });

    const membership = await getMembership(teamId, memberId);
    expect(membership).not.toBeNull();
    expect(membership!.polar_seat_id).toBe("seat_replacement");
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
