import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_PASSWORD = "TestPassword123!";
const ts = Date.now();

// Teams billing is plan-independent: every owner below stays on the free plan
// with the default personal quota (request_limit 50, requests_used 0).
const OWNER_TEAM_EMAIL = `test-tq-owner-team-${ts}@webhooks-test.local`;
const OWNER_FALLBACK_EMAIL = `test-tq-owner-fallback-${ts}@webhooks-test.local`;
const OWNER_SOLO_EMAIL = `test-tq-owner-solo-${ts}@webhooks-test.local`;

let ownerTeamId: string;
let ownerFallbackId: string;
let ownerSoloId: string;

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

async function createTestEndpoint(userId: string, name: string) {
  const endpoint = await createEndpointForUser({ userId, name });
  createdEndpointIds.push(endpoint.id);
  return endpoint;
}

/**
 * Share an endpoint into a team by direct insert (team_endpoints is deny-all
 * under RLS; the service-role client bypasses it).
 */
async function shareEndpoint(
  teamId: string,
  endpointId: string,
  sharedBy: string,
  sharedAt?: Date
) {
  const row: Record<string, unknown> = {
    team_id: teamId,
    endpoint_id: endpointId,
    shared_by: sharedBy,
  };
  if (sharedAt) row.shared_at = sharedAt.toISOString();

  const { error } = await admin.from("team_endpoints").insert(row);
  if (error) throw error;
}

/**
 * Call the receiver's hot-path stored procedure.
 *
 * p_body_raw is passed explicitly (as null) because the dev database still
 * carries a legacy 9-argument capture_webhook overload from migration 00018.
 * Omitting p_body_raw makes PostgREST report "Could not choose the best
 * candidate function"; naming all 10 parameters resolves unambiguously to the
 * current 10-argument version the Rust receiver calls.
 */
async function capture(slug: string) {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "POST",
    p_path: "/",
    p_headers: { "content-type": "application/json" },
    p_body: '{"n":1}',
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "127.0.0.1",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
  });
  if (error) throw error;
  return data as { status: string; retry_after?: number | null };
}

async function activateTeam(teamId: string, seats: number) {
  const { error } = await admin
    .from("teams")
    .update({
      subscription_status: "active",
      seats,
      request_limit: seats * 100_000,
      requests_used: 0,
      period_start: new Date().toISOString(),
      period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      polar_subscription_id: `sub_test_${teamId.slice(0, 8)}`,
    })
    .eq("id", teamId);
  if (error) throw error;
}

async function deactivateTeam(teamId: string) {
  const { error } = await admin
    .from("teams")
    .update({ subscription_status: null })
    .eq("id", teamId);
  if (error) throw error;
}

async function getTeam(teamId: string) {
  const { data, error } = await admin
    .from("teams")
    .select("id, subscription_status, seats, requests_used, request_limit, period_end")
    .eq("id", teamId)
    .single();
  if (error) throw error;
  return data as {
    id: string;
    subscription_status: string | null;
    requests_used: number;
    request_limit: number;
  };
}

async function getUserUsage(userId: string) {
  const { data, error } = await admin
    .from("users")
    .select("id, plan, requests_used, request_limit")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data as { id: string; plan: string; requests_used: number; request_limit: number };
}

async function getRequests(endpointId: string) {
  const { data, error } = await admin
    .from("requests")
    .select("id, endpoint_id, user_id, team_id, received_at")
    .eq("endpoint_id", endpointId)
    .order("received_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as { id: string; user_id: string | null; team_id: string | null }[];
}

beforeAll(async () => {
  ownerTeamId = await createTestUser(OWNER_TEAM_EMAIL, "TQ Team Owner");
  ownerFallbackId = await createTestUser(OWNER_FALLBACK_EMAIL, "TQ Fallback Owner");
  ownerSoloId = await createTestUser(OWNER_SOLO_EMAIL, "TQ Solo Owner");
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

describe("capture_webhook team-pooled quota", () => {
  it("bills an actively-subscribed team and stamps requests.team_id", async () => {
    const teamId = await createTestTeam(ownerTeamId, `TQ Billed ${ts}`);
    const endpoint = await createTestEndpoint(ownerTeamId, "TQ billed endpoint");
    await shareEndpoint(teamId, endpoint.id, ownerTeamId);
    await activateTeam(teamId, 2);

    const result = await capture(endpoint.slug);
    expect(result.status).toBe("ok");

    const team = await getTeam(teamId);
    expect(team.request_limit).toBe(200_000);
    expect(team.requests_used).toBe(1);

    const requests = await getRequests(endpoint.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.team_id).toBe(teamId);
    expect(requests[0]!.user_id).toBe(ownerTeamId);

    // Personal quota untouched — the team pool absorbed the request.
    const owner = await getUserUsage(ownerTeamId);
    expect(owner.requests_used).toBe(0);
  });

  it("returns quota_exceeded with retry_after when the team pool is exhausted", async () => {
    const teamId = await createTestTeam(ownerTeamId, `TQ Exhausted ${ts}`);
    const endpoint = await createTestEndpoint(ownerTeamId, "TQ exhausted endpoint");
    await shareEndpoint(teamId, endpoint.id, ownerTeamId);
    await activateTeam(teamId, 1);

    const { error: updateError } = await admin
      .from("teams")
      .update({ requests_used: 100_000 })
      .eq("id", teamId);
    if (updateError) throw updateError;

    const result = await capture(endpoint.slug);
    expect(result.status).toBe("quota_exceeded");
    expect(result.retry_after).toBeGreaterThan(0);

    // Pool must not overshoot its limit, and nothing may be captured.
    const team = await getTeam(teamId);
    expect(team.requests_used).toBe(100_000);

    const requests = await getRequests(endpoint.id);
    expect(requests).toHaveLength(0);
  });

  it("falls back to the owner's personal quota when the team has no subscription", async () => {
    const teamId = await createTestTeam(ownerFallbackId, `TQ Inactive ${ts}`);
    const endpoint = await createTestEndpoint(ownerFallbackId, "TQ inactive endpoint");
    await shareEndpoint(teamId, endpoint.id, ownerFallbackId);
    // subscription_status stays null — team is not billable.

    const result = await capture(endpoint.slug);
    expect(result.status).toBe("ok");

    const team = await getTeam(teamId);
    expect(team.subscription_status).toBeNull();
    expect(team.requests_used).toBe(0);

    const requests = await getRequests(endpoint.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.team_id).toBeNull();

    const owner = await getUserUsage(ownerFallbackId);
    expect(owner.requests_used).toBe(1);
  });

  it("bills the oldest active share, and the next one after it is deactivated", async () => {
    const firstTeamId = await createTestTeam(ownerTeamId, `TQ Oldest ${ts}`);
    const secondTeamId = await createTestTeam(ownerTeamId, `TQ Newest ${ts}`);
    const endpoint = await createTestEndpoint(ownerTeamId, "TQ multi-share endpoint");

    const earlier = new Date(Date.now() - 60_000);
    const later = new Date();
    await shareEndpoint(firstTeamId, endpoint.id, ownerTeamId, earlier);
    await shareEndpoint(secondTeamId, endpoint.id, ownerTeamId, later);

    await activateTeam(firstTeamId, 1);
    await activateTeam(secondTeamId, 1);

    const first = await capture(endpoint.slug);
    expect(first.status).toBe("ok");

    expect((await getTeam(firstTeamId)).requests_used).toBe(1);
    expect((await getTeam(secondTeamId)).requests_used).toBe(0);

    const afterFirst = await getRequests(endpoint.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.team_id).toBe(firstTeamId);

    // Deactivating the oldest share hands billing to the next active team.
    await deactivateTeam(firstTeamId);

    const second = await capture(endpoint.slug);
    expect(second.status).toBe("ok");

    expect((await getTeam(firstTeamId)).requests_used).toBe(1);
    expect((await getTeam(secondTeamId)).requests_used).toBe(1);

    const afterSecond = await getRequests(endpoint.id);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[1]!.team_id).toBe(secondTeamId);

    // Owner's personal quota never participated.
    expect((await getUserUsage(ownerTeamId)).requests_used).toBe(0);
  });

  it("leaves unshared endpoints on the owner's personal quota", async () => {
    const endpoint = await createTestEndpoint(ownerSoloId, "TQ unshared endpoint");

    const result = await capture(endpoint.slug);
    expect(result.status).toBe("ok");

    const requests = await getRequests(endpoint.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.team_id).toBeNull();
    expect(requests[0]!.user_id).toBe(ownerSoloId);

    const owner = await getUserUsage(ownerSoloId);
    expect(owner.plan).toBe("free");
    expect(owner.requests_used).toBe(1);
  });
});
