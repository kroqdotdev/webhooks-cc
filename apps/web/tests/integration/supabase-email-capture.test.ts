import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser, createGuestEndpoint } from "@/lib/supabase/endpoints";

/**
 * Email capture at the database level (migration 00048).
 *
 * An email is an ordinary request: it must land on exactly the same quota row
 * and counters as an HTTP capture, nothing more and nothing less. Every test
 * uses its own account and reads the counters before and after, so a double
 * count or a missed count fails here rather than on a customer's invoice.
 */

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
let userCounter = 0;

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
const createdEndpointIds: string[] = [];

const EMAIL_DOC = {
  from: [{ name: "Sender", address: "sender@example.com" }],
  to: [{ name: null, address: "slug@mailhooks.cc" }],
  subject: "Welcome",
  text: "Hello",
  attachments: [],
};

async function createTestUser(): Promise<string> {
  userCounter += 1;
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-email-capture-${userCounter}-${ts}@webhooks-test.local`,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  const userId = data.user!.id;
  createdUserIds.push(userId);
  return userId;
}

async function createTestEndpoint(userId: string, name = "email capture") {
  const endpoint = await createEndpointForUser({ userId, name });
  createdEndpointIds.push(endpoint.id);
  return endpoint;
}

async function createTestTeam(userId: string): Promise<string> {
  const { data, error } = await admin.rpc("create_team_with_owner", {
    p_user_id: userId,
    p_name: `Email team ${createdTeamIds.length} ${ts}`,
  });
  if (error) throw error;
  const team = data as { id?: string; error?: string };
  if (!team.id) throw new Error(`create_team_with_owner failed: ${team.error}`);
  createdTeamIds.push(team.id);
  return team.id;
}

async function shareAndActivate(
  teamId: string,
  endpointId: string,
  ownerId: string,
  requestsUsed = 0
) {
  const { error: shareError } = await admin
    .from("team_endpoints")
    .insert({ team_id: teamId, endpoint_id: endpointId, shared_by: ownerId });
  if (shareError) throw shareError;
  const { error } = await admin
    .from("teams")
    .update({
      subscription_status: "active",
      seats: 1,
      request_limit: 100_000,
      requests_used: requestsUsed,
      period_start: new Date().toISOString(),
      period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      polar_subscription_id: `sub_test_${teamId.slice(0, 8)}`,
    })
    .eq("id", teamId);
  if (error) throw error;
}

async function setUserQuota(
  userId: string,
  fields: {
    plan?: "free" | "pro";
    requests_used?: number;
    request_limit?: number;
    period_end?: string | null;
  }
) {
  const { error } = await admin.from("users").update(fields).eq("id", userId);
  if (error) throw error;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function getUser(userId: string) {
  const { data, error } = await admin
    .from("users")
    .select("plan, requests_used, request_limit, period_end")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data as {
    plan: string;
    requests_used: number;
    request_limit: number;
    period_end: string | null;
  };
}

async function getTeamUsed(teamId: string): Promise<number> {
  const { data, error } = await admin
    .from("teams")
    .select("requests_used")
    .eq("id", teamId)
    .single();
  if (error) throw error;
  return (data as { requests_used: number }).requests_used;
}

async function getEndpointCount(endpointId: string): Promise<number> {
  const { data, error } = await admin
    .from("endpoints")
    .select("request_count")
    .eq("id", endpointId)
    .single();
  if (error) throw error;
  return (data as { request_count: number }).request_count;
}

type RequestRow = {
  id: string;
  kind: string;
  email: Record<string, unknown> | null;
  method: string;
  path: string;
  content_type: string | null;
  user_id: string | null;
  team_id: string | null;
  size: number;
  dedupe_key: string | null;
};

async function getRequests(endpointId: string): Promise<RequestRow[]> {
  const { data, error } = await admin
    .from("requests")
    .select("id, kind, email, method, path, content_type, user_id, team_id, size, dedupe_key")
    .eq("endpoint_id", endpointId)
    .order("received_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as RequestRow[];
}

async function getDailyStats(endpointId: string) {
  const { data, error } = await admin
    .from("endpoint_daily_stats")
    .select("captured, team_billed, quota_rejected, bytes")
    .eq("endpoint_id", endpointId);
  if (error) throw error;
  const rows = (data ?? []) as {
    captured: number;
    team_billed: number;
    quota_rejected: number;
    bytes: number;
  }[];
  const sum = (key: keyof (typeof rows)[number]) =>
    rows.reduce((total, row) => total + Number(row[key]), 0);
  return {
    rows: rows.length,
    captured: sum("captured"),
    teamBilled: sum("team_billed"),
    quotaRejected: sum("quota_rejected"),
    bytes: sum("bytes"),
  };
}

type CaptureResult = { status: string; request_id?: string; billing_key?: string };

/** The receiver's email capture call: all 15 arguments. */
async function captureEmail(
  slug: string,
  opts: { dedupeKey?: string | null; retry?: boolean; size?: number | null } = {}
): Promise<CaptureResult> {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "EMAIL",
    p_path: `${slug}+signup@mailhooks.cc`,
    p_headers: { subject: "Welcome", from: "Sender <sender@example.com>" },
    p_body: "Subject: Welcome\r\n\r\nHello\r\n",
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
    p_kind: "email",
    p_email: EMAIL_DOC,
    p_dedupe_key: opts.dedupeKey ?? null,
    p_retry: opts.retry ?? false,
    p_size: opts.size ?? null,
  });
  if (error) throw error;
  return data as CaptureResult;
}

/** The receiver's current HTTP call: exactly the 10 arguments it sends today. */
async function captureHttp(slug: string) {
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

async function checkRecipient(slug: string) {
  const { data, error } = await admin.rpc("check_email_recipient", { p_slug: slug });
  if (error) throw error;
  return data as { status: string; endpoint_id?: string };
}

const messageKey = (label: string) => `sha256-${label}-${ts}`;

afterAll(async () => {
  if (createdEndpointIds.length > 0) {
    // Zero the counts first so deleting the endpoints does not inflate the
    // public site total (migration 00038 moves deleted counts into it).
    await admin.from("endpoints").update({ request_count: 0 }).in("id", createdEndpointIds);
    await admin.from("requests").delete().in("endpoint_id", createdEndpointIds);
    await admin.from("endpoint_daily_stats").delete().in("endpoint_id", createdEndpointIds);
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

describe("capture_webhook with kind = 'email'", () => {
  it("stores an email as one request and counts it exactly once", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);

    const result = await captureEmail(endpoint.slug);
    expect(result.status).toBe("ok");
    expect(result.billing_key).toBe(`user:${userId}`);

    const rows = await getRequests(endpoint.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.request_id,
      kind: "email",
      method: "EMAIL",
      path: `${endpoint.slug}+signup@mailhooks.cc`,
      content_type: "message/rfc822",
      user_id: userId,
      team_id: null,
      dedupe_key: null,
    });
    expect(rows[0].email).toMatchObject({ subject: "Welcome", text: "Hello" });

    // The capture started the Free period and billed exactly one request.
    const user = await getUser(userId);
    expect(user.requests_used).toBe(1);
    expect(user.period_end).not.toBeNull();
    expect(await getEndpointCount(endpoint.id)).toBe(1);
    expect(await getDailyStats(endpoint.id)).toMatchObject({
      captured: 1,
      teamBilled: 0,
      quotaRejected: 0,
    });
  });

  it("shares the quota with HTTP captures: each one is one request", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);

    expect((await captureHttp(endpoint.slug)).status).toBe("ok");
    expect((await captureEmail(endpoint.slug)).status).toBe("ok");
    expect((await captureHttp(endpoint.slug)).status).toBe("ok");

    expect((await getUser(userId)).requests_used).toBe(3);
    expect(await getEndpointCount(endpoint.id)).toBe(3);
    const kinds = (await getRequests(endpoint.id)).map((row) => row.kind).sort();
    expect(kinds).toEqual(["email", "http", "http"]);
  });

  it("keeps the 10-argument HTTP call working with kind 'http' and no email", async () => {
    const endpoint = await createTestEndpoint(await createTestUser());
    expect((await captureHttp(endpoint.slug)).status).toBe("ok");
    const rows = await getRequests(endpoint.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "http", email: null, dedupe_key: null });
  });

  it("records the real message size when the stored body is shorter", async () => {
    const endpoint = await createTestEndpoint(await createTestUser());
    expect((await captureEmail(endpoint.slug, { size: 9_000_000 })).status).toBe("ok");
    const rows = await getRequests(endpoint.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].size).toBe(9_000_000);
    expect((await getDailyStats(endpoint.id)).bytes).toBe(9_000_000);
  });

  it("refuses email to a guest endpoint without touching any counter", async () => {
    const guest = await createGuestEndpoint();
    createdEndpointIds.push(guest.id);
    const before = await getEndpointCount(guest.id);

    const result = await captureEmail(guest.slug);
    expect(result.status).toBe("not_allowed");
    expect(await getRequests(guest.id)).toHaveLength(0);
    expect(await getEndpointCount(guest.id)).toBe(before);
    expect((await getDailyStats(guest.id)).rows).toBe(0);
  });

  it("refuses an expired endpoint and stores nothing", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    const { error } = await admin
      .from("endpoints")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", endpoint.id);
    if (error) throw error;

    expect((await captureEmail(endpoint.slug)).status).toBe("expired");
    expect(await getRequests(endpoint.id)).toHaveLength(0);
    expect((await getUser(userId)).requests_used).toBe(0);
  });

  it("answers quota_exceeded for a full Free period and stores nothing", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    await setUserQuota(userId, {
      plan: "free",
      request_limit: 50,
      requests_used: 50,
      period_end: new Date(Date.now() + 3_600_000).toISOString(),
    });

    expect((await captureEmail(endpoint.slug)).status).toBe("quota_exceeded");
    expect(await getRequests(endpoint.id)).toHaveLength(0);
    expect((await getUser(userId)).requests_used).toBe(50);
    expect(await getDailyStats(endpoint.id)).toMatchObject({ captured: 0, quotaRejected: 1 });
  });

  it("answers quota_exceeded for a full Pro period and stores nothing", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    await setUserQuota(userId, {
      plan: "pro",
      request_limit: 100_000,
      requests_used: 100_000,
      period_end: inDays(10),
    });

    expect((await captureEmail(endpoint.slug)).status).toBe("quota_exceeded");
    expect(await getRequests(endpoint.id)).toHaveLength(0);
    expect((await getUser(userId)).requests_used).toBe(100_000);
    expect(await getEndpointCount(endpoint.id)).toBe(0);
  });

  it("bills a team-shared endpoint to the team pool, not the owner", async () => {
    const userId = await createTestUser();
    const teamId = await createTestTeam(userId);
    const endpoint = await createTestEndpoint(userId);
    await shareAndActivate(teamId, endpoint.id, userId);

    const result = await captureEmail(endpoint.slug);
    expect(result.status).toBe("ok");
    expect(result.billing_key).toBe(`team:${teamId}`);
    expect(await getTeamUsed(teamId)).toBe(1);
    expect((await getUser(userId)).requests_used).toBe(0);
    expect(await getEndpointCount(endpoint.id)).toBe(1);
    expect(await getDailyStats(endpoint.id)).toMatchObject({ captured: 1, teamBilled: 1 });
    const rows = await getRequests(endpoint.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].team_id).toBe(teamId);
  });

  it("refuses when the team pool is full, without falling back to the owner", async () => {
    const userId = await createTestUser();
    const teamId = await createTestTeam(userId);
    const endpoint = await createTestEndpoint(userId);
    await shareAndActivate(teamId, endpoint.id, userId, 100_000);

    expect((await captureEmail(endpoint.slug)).status).toBe("quota_exceeded");
    expect(await getTeamUsed(teamId)).toBe(100_000);
    expect((await getUser(userId)).requests_used).toBe(0);
    expect(await getRequests(endpoint.id)).toHaveLength(0);
  });

  it("bills the owner when the team is no longer subscribed", async () => {
    const userId = await createTestUser();
    const teamId = await createTestTeam(userId);
    const endpoint = await createTestEndpoint(userId);
    await shareAndActivate(teamId, endpoint.id, userId);
    const { error } = await admin
      .from("teams")
      .update({ subscription_status: null })
      .eq("id", teamId);
    if (error) throw error;

    expect(await checkRecipient(endpoint.slug)).toMatchObject({ status: "ok" });
    const result = await captureEmail(endpoint.slug);
    expect(result.status).toBe("ok");
    expect(result.billing_key).toBe(`user:${userId}`);
    expect((await getUser(userId)).requests_used).toBe(1);
    expect(await getTeamUsed(teamId)).toBe(0);
    const rows = await getRequests(endpoint.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].team_id).toBeNull();
  });

  it("rejects an unknown kind before anything is billed", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    const { error } = await admin.rpc("capture_webhook", {
      p_slug: endpoint.slug,
      p_method: "EMAIL",
      p_path: "/",
      p_headers: {},
      p_body: "",
      p_query_params: {},
      p_content_type: null,
      p_ip: "",
      p_received_at: new Date().toISOString(),
      p_body_raw: null,
      p_kind: "EMAIL",
    });
    expect(error?.code).toBe("22023");
    expect((await getUser(userId)).requests_used).toBe(0);
    expect(await getRequests(endpoint.id)).toHaveLength(0);
  });
});

describe("retry protection", () => {
  it("returns the stored copy for a retry and bills nothing", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    const key = messageKey("retry");

    const first = await captureEmail(endpoint.slug, { dedupeKey: key });
    expect(first.status).toBe("ok");
    const retry = await captureEmail(endpoint.slug, { dedupeKey: key, retry: true });
    expect(retry).toEqual({ status: "duplicate", request_id: first.request_id });

    expect((await getUser(userId)).requests_used).toBe(1);
    expect(await getEndpointCount(endpoint.id)).toBe(1);
    expect((await getDailyStats(endpoint.id)).captured).toBe(1);
    const rows = await getRequests(endpoint.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(key);
  });

  it("captures the same message again when it is not a retry", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    const key = messageKey("resend");

    expect((await captureEmail(endpoint.slug, { dedupeKey: key })).status).toBe("ok");
    expect((await captureEmail(endpoint.slug, { dedupeKey: key })).status).toBe("ok");
    expect((await getUser(userId)).requests_used).toBe(2);
    expect(await getRequests(endpoint.id)).toHaveLength(2);
  });

  it("captures a retry whose earlier attempt stored nothing", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    const result = await captureEmail(endpoint.slug, {
      dedupeKey: messageKey("fresh-retry"),
      retry: true,
    });
    expect(result.status).toBe("ok");
    expect((await getUser(userId)).requests_used).toBe(1);
  });

  it("matches copies per endpoint only", async () => {
    const userId = await createTestUser();
    const a = await createTestEndpoint(userId, "email a");
    const b = await createTestEndpoint(userId, "email b");
    const key = messageKey("per-endpoint");

    expect((await captureEmail(a.slug, { dedupeKey: key })).status).toBe("ok");
    expect((await captureEmail(b.slug, { dedupeKey: key, retry: true })).status).toBe("ok");
    expect((await getUser(userId)).requests_used).toBe(2);
  });

  it("captures concurrent retries of one message exactly once", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    const key = messageKey("concurrent");

    const results = await Promise.all(
      [0, 1, 2].map(() => captureEmail(endpoint.slug, { dedupeKey: key, retry: true }))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["duplicate", "duplicate", "ok"]);
    const ids = new Set(results.map((r) => r.request_id));
    expect(ids.size).toBe(1);

    expect((await getUser(userId)).requests_used).toBe(1);
    expect(await getRequests(endpoint.id)).toHaveLength(1);
  });
});

describe("check_email_recipient", () => {
  it("reports unknown slugs", async () => {
    expect(await checkRecipient(`nope${ts}`)).toEqual({ status: "unknown" });
  });

  it("reports guest endpoints", async () => {
    const guest = await createGuestEndpoint();
    createdEndpointIds.push(guest.id);
    expect(await checkRecipient(guest.slug)).toMatchObject({ status: "guest" });
  });

  it("reports expired endpoints", async () => {
    const endpoint = await createTestEndpoint(await createTestUser());
    const { error } = await admin
      .from("endpoints")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", endpoint.id);
    if (error) throw error;
    expect(await checkRecipient(endpoint.slug)).toMatchObject({ status: "expired" });
  });

  it("accepts a Free account with no running period and changes nothing", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);

    expect(await checkRecipient(endpoint.slug)).toEqual({
      status: "ok",
      endpoint_id: endpoint.id,
    });
    const user = await getUser(userId);
    expect(user.requests_used).toBe(0);
    expect(user.period_end).toBeNull();
    expect(await getEndpointCount(endpoint.id)).toBe(0);
  });

  it("reports over_quota for an exhausted Free period and agrees with capture after it ends", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    await setUserQuota(userId, {
      plan: "free",
      request_limit: 50,
      requests_used: 50,
      period_end: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await checkRecipient(endpoint.slug)).toMatchObject({ status: "over_quota" });

    await setUserQuota(userId, { period_end: new Date(Date.now() - 60_000).toISOString() });
    expect(await checkRecipient(endpoint.slug)).toMatchObject({ status: "ok" });
    expect((await getUser(userId)).requests_used).toBe(50);

    // The capture starts the new period and bills it once.
    expect((await captureEmail(endpoint.slug)).status).toBe("ok");
    expect((await getUser(userId)).requests_used).toBe(1);
  });

  it("follows the team pool for team-shared endpoints", async () => {
    const userId = await createTestUser();
    const teamId = await createTestTeam(userId);
    const endpoint = await createTestEndpoint(userId);
    await shareAndActivate(teamId, endpoint.id, userId);
    expect(await checkRecipient(endpoint.slug)).toMatchObject({ status: "ok" });

    const { error } = await admin.from("teams").update({ requests_used: 100_000 }).eq("id", teamId);
    if (error) throw error;
    expect(await checkRecipient(endpoint.slug)).toMatchObject({ status: "over_quota" });
  });

  it("agrees with capture_webhook at the exact Pro quota boundary", async () => {
    const userId = await createTestUser();
    const endpoint = await createTestEndpoint(userId);
    await setUserQuota(userId, {
      plan: "pro",
      request_limit: 100_000,
      requests_used: 99_999,
      period_end: inDays(10),
    });

    expect(await checkRecipient(endpoint.slug)).toMatchObject({ status: "ok" });
    expect((await captureEmail(endpoint.slug)).status).toBe("ok");
    expect(await checkRecipient(endpoint.slug)).toMatchObject({ status: "over_quota" });
    expect((await captureEmail(endpoint.slug)).status).toBe("quota_exceeded");
    expect((await getUser(userId)).requests_used).toBe(100_000);
  });
});
