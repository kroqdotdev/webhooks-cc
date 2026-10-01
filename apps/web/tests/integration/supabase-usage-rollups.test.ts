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

const ts = Date.now();
const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
const createdEndpointIds: string[] = [];

async function createTestUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-rollup-${label}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  createdUserIds.push(data.user!.id);
  return data.user!.id;
}

async function createTestEndpoint(userId: string) {
  const endpoint = await createEndpointForUser({ userId, name: "rollup endpoint" });
  createdEndpointIds.push(endpoint.id);
  return endpoint;
}

// All 10 parameters are named: the dev database still carries a legacy
// 9-argument overload (see supabase-team-quota.test.ts).
async function capture(slug: string, body = '{"n":1}') {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "POST",
    p_path: "/",
    p_headers: { "content-type": "application/json" },
    p_body: body,
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "127.0.0.1",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
  });
  if (error) throw error;
  return data as { status: string };
}

async function statsFor(endpointId: string) {
  const { data, error } = await admin
    .from("endpoint_daily_stats")
    .select("day, user_id, team_id, captured, team_billed, quota_rejected, bytes")
    .eq("endpoint_id", endpointId);
  if (error) throw error;
  return data ?? [];
}

const today = new Date().toISOString().slice(0, 10);

afterAll(async () => {
  if (createdEndpointIds.length > 0) {
    await admin.from("endpoint_daily_stats").delete().in("endpoint_id", createdEndpointIds);
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

describe("endpoint_daily_stats", () => {
  let ownerId: string;

  beforeAll(async () => {
    ownerId = await createTestUser("owner");
  });

  it("counts captures and bytes per endpoint per UTC day", async () => {
    const endpoint = await createTestEndpoint(ownerId);
    expect((await capture(endpoint.slug, "abc")).status).toBe("ok");
    expect((await capture(endpoint.slug, "abcdef")).status).toBe("ok");

    expect(await statsFor(endpoint.id)).toEqual([
      {
        day: today,
        user_id: ownerId,
        team_id: null,
        captured: 2,
        team_billed: 0,
        quota_rejected: 0,
        bytes: 9,
      },
    ]);
  });

  it("counts quota rejections separately from captures", async () => {
    const userId = await createTestUser("exhausted");
    const endpoint = await createTestEndpoint(userId);
    expect((await capture(endpoint.slug)).status).toBe("ok");

    const { error } = await admin
      .from("users")
      .update({ requests_used: 50, request_limit: 50 })
      .eq("id", userId);
    if (error) throw error;

    expect((await capture(endpoint.slug)).status).toBe("quota_exceeded");
    expect((await capture(endpoint.slug)).status).toBe("quota_exceeded");

    const [row] = await statsFor(endpoint.id);
    expect(row).toMatchObject({ captured: 1, quota_rejected: 2 });
  });

  it("records team-billed captures with the billing team", async () => {
    const { data, error } = await admin.rpc("create_team_with_owner", {
      p_user_id: ownerId,
      p_name: `Rollup ${ts}`,
    });
    if (error) throw error;
    const teamId = (data as { id: string }).id;
    createdTeamIds.push(teamId);

    const { error: activateError } = await admin
      .from("teams")
      .update({
        subscription_status: "active",
        seats: 1,
        request_limit: 100_000,
        requests_used: 0,
        period_start: new Date().toISOString(),
        period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        polar_subscription_id: `sub_rollup_${ts}`,
      })
      .eq("id", teamId);
    if (activateError) throw activateError;

    const endpoint = await createTestEndpoint(ownerId);
    expect((await capture(endpoint.slug)).status).toBe("ok");

    const { error: shareError } = await admin
      .from("team_endpoints")
      .insert({ team_id: teamId, endpoint_id: endpoint.id, shared_by: ownerId });
    if (shareError) throw shareError;

    expect((await capture(endpoint.slug)).status).toBe("ok");

    const [row] = await statsFor(endpoint.id);
    expect(row).toMatchObject({ captured: 2, team_billed: 1, team_id: teamId });
  });

  it("keeps history after the endpoint is deleted", async () => {
    const endpoint = await createTestEndpoint(ownerId);
    expect((await capture(endpoint.slug)).status).toBe("ok");

    const { error } = await admin.from("endpoints").delete().eq("id", endpoint.id);
    if (error) throw error;

    const [row] = await statsFor(endpoint.id);
    expect(row).toMatchObject({ captured: 1, user_id: ownerId });
  });
});

describe("audit_events and endpoint_daily_stats access", () => {
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  it.skipIf(!anonKey)("are not readable or writable by anon", async () => {
    const anon = createClient(SUPABASE_URL, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    for (const table of ["audit_events", "endpoint_daily_stats"] as const) {
      const { error } = await anon.from(table).select("*").limit(1);
      expect(error, `${table} select`).not.toBeNull();
    }

    const { error: insertError } = await anon
      .from("audit_events")
      .insert({ actor_type: "system", action: "test.anon_insert" });
    expect(insertError).not.toBeNull();
  });

  it("accepts service-role inserts", async () => {
    const { data, error } = await admin
      .from("audit_events")
      .insert({ actor_type: "system", action: "test.integration", metadata: { ts } })
      .select("id")
      .single();
    expect(error).toBeNull();
    await admin.from("audit_events").delete().eq("id", data!.id);
  });
});
