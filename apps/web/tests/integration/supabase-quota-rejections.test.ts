import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { buildQuotaExhaustedEmail } from "@/lib/email/quota-exhausted-email";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { getQuotaRejections } from "@/lib/supabase/quota-rejections";
import { getUsageForUser } from "@/lib/supabase/usage";

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
    email: `test-quota-rej-${label}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  createdUserIds.push(data.user!.id);
  return data.user!.id;
}

async function createTestEndpoint(userId: string) {
  const endpoint = await createEndpointForUser({ userId, name: "quota rejection endpoint" });
  createdEndpointIds.push(endpoint.id);
  return endpoint;
}

// All 10 parameters are named: the dev database still carries a legacy
// 9-argument overload (see supabase-team-quota.test.ts).
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
  return data as { status: string };
}

/** Puts a user at their free limit with a period that began a moment ago. */
async function exhaust(userId: string) {
  const { error } = await admin
    .from("users")
    .update({
      plan: "free",
      requests_used: 50,
      request_limit: 50,
      period_start: new Date(Date.now() - 60_000).toISOString(),
      period_end: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    .eq("id", userId);
  if (error) throw error;
}

async function reject(slug: string, times: number) {
  for (let i = 0; i < times; i++) {
    expect((await capture(slug)).status).toBe("quota_exceeded");
  }
}

async function rejections(userId: string, limit = 5) {
  const { data, error } = await admin.rpc("get_quota_rejections", {
    p_user_id: userId,
    p_limit: limit,
  });
  if (error) throw error;
  return data as {
    slug: string;
    quota_rejected: number;
    total_rejected: number;
    endpoint_count: number;
  }[];
}

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

describe("get_quota_rejections", () => {
  let userId: string;
  let busy: { id: string; slug: string };
  let quiet: { id: string; slug: string };
  let shared: { id: string; slug: string };

  beforeAll(async () => {
    userId = await createTestUser("owner");
    busy = await createTestEndpoint(userId);
    quiet = await createTestEndpoint(userId);
    shared = await createTestEndpoint(userId);
    await exhaust(userId);

    await reject(busy.slug, 3);
    await reject(quiet.slug, 1);
    await reject(shared.slug, 2);
  });

  it("returns nothing for a user with no rejections", async () => {
    const otherId = await createTestUser("none");
    await createTestEndpoint(otherId);
    expect(await rejections(otherId)).toEqual([]);
  });

  it("returns each endpoint's count, most rejected first, with totals", async () => {
    expect(await rejections(userId)).toEqual([
      { slug: busy.slug, quota_rejected: 3, total_rejected: 6, endpoint_count: 3 },
      { slug: shared.slug, quota_rejected: 2, total_rejected: 6, endpoint_count: 3 },
      { slug: quiet.slug, quota_rejected: 1, total_rejected: 6, endpoint_count: 3 },
    ]);
  });

  it("limits the rows but not the totals", async () => {
    const rows = await rejections(userId, 1);
    expect(rows).toEqual([
      { slug: busy.slug, quota_rejected: 3, total_rejected: 6, endpoint_count: 3 },
    ]);
    expect(await rejections(userId, 0)).toEqual([]);
  });

  it("only counts days from the UTC date of the period start", async () => {
    // endpoint_daily_stats cannot be written from here, so move the period
    // instead: every row so far is dated today, before a period that starts
    // in two days.
    const setPeriodStart = async (periodStart: Date) => {
      const { error } = await admin
        .from("users")
        .update({ period_start: periodStart.toISOString() })
        .eq("id", userId);
      if (error) throw error;
    };

    await setPeriodStart(new Date(Date.now() + 2 * 86_400_000));
    expect(await rejections(userId)).toEqual([]);

    await setPeriodStart(new Date(Date.now() - 60_000));
    expect((await rejections(userId))[0].total_rejected).toBe(6);
  });

  it("matches what the email and usage report for the owner", async () => {
    const summary = await getQuotaRejections(userId);
    expect(summary).toEqual({
      total: 6,
      endpointCount: 3,
      endpoints: [
        { slug: busy.slug, rejected: 3 },
        { slug: shared.slug, rejected: 2 },
        { slug: quiet.slug, rejected: 1 },
      ],
    });

    const email = buildQuotaExhaustedEmail({
      to: "owner@example.com",
      requestLimit: 50,
      periodEnd: new Date(Date.now() + 60 * 60_000),
      teamBilledEndpoints: 0,
      rejections: summary,
      appUrl: "https://webhooks.cc",
    });
    expect(email.text).toContain("6 webhooks were rejected across 3 endpoints");
    expect(email.text).toContain(`${busy.slug}: 3 rejected webhooks`);
    expect(email.text).toContain(`${quiet.slug}: 1 rejected webhook\n`);

    expect((await getUsageForUser(userId))?.quotaRejections).toEqual(summary);
  });

  it("leaves out endpoints billed to a subscribed team", async () => {
    const { data, error } = await admin.rpc("create_team_with_owner", {
      p_user_id: userId,
      p_name: `QuotaRej ${ts}`,
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
        polar_subscription_id: `sub_quota_rej_${ts}`,
      })
      .eq("id", teamId);
    if (activateError) throw activateError;

    const { error: shareError } = await admin
      .from("team_endpoints")
      .insert({ team_id: teamId, endpoint_id: shared.id, shared_by: userId });
    if (shareError) throw shareError;

    expect(await rejections(userId)).toEqual([
      { slug: busy.slug, quota_rejected: 3, total_rejected: 4, endpoint_count: 2 },
      { slug: quiet.slug, quota_rejected: 1, total_rejected: 4, endpoint_count: 2 },
    ]);
  });

  it("is only included in usage while the quota is exhausted", async () => {
    const [first] = await rejections(userId);
    expect((await getUsageForUser(userId))?.quotaRejections.total).toBe(first.total_rejected);

    const { error } = await admin.from("users").update({ requests_used: 10 }).eq("id", userId);
    if (error) throw error;

    expect((await getUsageForUser(userId))?.quotaRejections).toEqual({
      total: 0,
      endpointCount: 0,
      endpoints: [],
    });
  });
});

describe("get_quota_rejections access", () => {
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  it.skipIf(!anonKey)("is not callable by anon or authenticated clients", async () => {
    const anon = createClient(SUPABASE_URL, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await anon.rpc("get_quota_rejections", {
      p_user_id: "00000000-0000-0000-0000-000000000000",
      p_limit: 1,
    });
    expect(error).not.toBeNull();
  });
});
