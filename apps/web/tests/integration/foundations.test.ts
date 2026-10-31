import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import {
  getNewestRetainedRequestId,
  getRequestByIdForUser,
  getRetainedRequestsByIds,
  listPaginatedRequestsForEndpointByUser,
  listRequestsForEndpointByUser,
} from "@/lib/supabase/requests";
import { requestIdsInRange } from "@/lib/replay";
import { countSearchRequestsForUser, searchRequestsForUser } from "@/lib/supabase/search";
import { ENTITLEMENTS, type Entitlements } from "@/lib/entitlements";
import type { PlanKey } from "@/lib/supabase/database";
import { getObjectBytes, isObjectStorageConfigured, listKeys } from "@/lib/storage/object-store";
import { deleteQueuedObjects } from "@/lib/storage/deleter";

/**
 * Migration 00067: the entitlement map, retention per account and endpoint,
 * the annual plan's monthly quota period, and object storage for email.
 * cleanup_expired_requests() and process_billing_period_resets() act on the
 * whole database, as their jobs do; each test only asserts on its own rows.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");
const SECRET = process.env.CAPTURE_SHARED_SECRET;
const MAIL_URL = (process.env.MAIL_INGEST_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
let counter = 0;
const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

async function createUser(fields: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-foundations-${counter}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const id = data.user!.id;
  createdUserIds.push(id);
  if (Object.keys(fields).length > 0) {
    const { error: updateError } = await admin.from("users").update(fields).eq("id", id);
    if (updateError) throw updateError;
  }
  return id;
}

async function insertRequests(
  endpointId: string,
  userId: string,
  ages: number[],
  extra: Record<string, unknown> = {}
): Promise<string[]> {
  const rows = ages.map((age) => ({
    endpoint_id: endpointId,
    user_id: userId,
    method: "POST",
    path: `/age-${age}`,
    ip: "127.0.0.1",
    received_at: daysAgo(age),
    ...extra,
  }));
  const { data, error } = await admin.from("requests").insert(rows).select("id");
  if (error) throw error;
  return (data as { id: string }[]).map((row) => row.id);
}

async function remaining(ids: string[]): Promise<Set<string>> {
  const { data, error } = await admin.from("requests").select("id").in("id", ids);
  if (error) throw error;
  return new Set((data as { id: string }[]).map((row) => row.id));
}

async function cleanup() {
  const { error } = await admin.rpc("cleanup_expired_requests", {
    p_batch: 5000,
    p_max_rows: 5_000_000,
  });
  if (error) throw error;
}

afterAll(async () => {
  for (const id of createdTeamIds) await admin.from("teams").delete().eq("id", id);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

describe("plan_entitlements", () => {
  it("matches lib/entitlements.ts row for row", async () => {
    const { data, error } = await admin.from("plan_entitlements").select("*");
    if (error) throw error;
    const rows = data as Record<string, unknown>[];
    expect(rows.map((row) => row.key).sort()).toEqual(Object.keys(ENTITLEMENTS).sort());
    for (const row of rows) {
      const mirror: Entitlements = ENTITLEMENTS[row.key as PlanKey];
      expect({
        key: row.key,
        requestLimit: row.request_limit,
        poolRequests: row.pool_requests,
        quotaPeriod: row.quota_period,
        retentionDays: row.retention_days,
        parsedPages: row.parsed_pages,
        layoutsPerEndpoint: row.layouts_per_endpoint,
        aiAssists: row.ai_assists,
        customDomains: row.custom_domains,
        fileDrops: row.file_drops,
        requestAddons: row.request_addons,
        pageAddons: row.page_addons,
        annualBilling: row.annual_billing,
      }).toEqual(mirror);
    }
  });

  it("accepts business as a plan and refuses anything else", async () => {
    const userId = await createUser({ plan: "business", request_limit: 250_000 });
    const { data } = await admin.from("users").select("plan").eq("id", userId).single();
    expect((data as { plan: string }).plan).toBe("business");
    const { error } = await admin.from("users").update({ plan: "enterprise" }).eq("id", userId);
    expect(error?.code).toBe("23514");
  });

  it("is not readable by client roles", async () => {
    const anon = createClient(
      process.env.SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { data } = await anon.from("plan_entitlements").select("*");
    expect(data ?? []).toEqual([]);
  });
});

describe("retention", () => {
  it("keeps each plan's days for personal rows", async () => {
    const free = await createUser();
    const pro = await createUser({ plan: "pro", request_limit: 100_000 });
    const business = await createUser({ plan: "business", request_limit: 250_000 });
    const freeEndpoint = await createEndpointForUser({ userId: free, name: "free" });
    const proEndpoint = await createEndpointForUser({ userId: pro, name: "pro" });
    const businessEndpoint = await createEndpointForUser({ userId: business, name: "business" });
    const [free6, free8] = await insertRequests(freeEndpoint.id, free, [6, 8]);
    const [pro30, pro32] = await insertRequests(proEndpoint.id, pro, [30, 32]);
    const [b89, b91] = await insertRequests(businessEndpoint.id, business, [89, 91]);

    await cleanup();

    const left = await remaining([free6, free8, pro30, pro32, b89, b91]);
    expect(left).toEqual(new Set([free6, pro30, b89]));
  });

  it("keeps the old plan's days during the grace after a downgrade", async () => {
    const userId = await createUser({
      retention_floor_days: 31,
      retention_floor_until: inDays(3),
    });
    const endpoint = await createEndpointForUser({ userId, name: "grace" });
    const ids = await insertRequests(endpoint.id, userId, [10, 30, 32]);
    await cleanup();
    expect(await remaining(ids)).toEqual(new Set([ids[0], ids[1]]));

    // Once the grace is over, the free plan's 7 days apply.
    await admin
      .from("users")
      .update({ retention_floor_until: daysAgo(1) })
      .eq("id", userId);
    await cleanup();
    expect((await remaining(ids)).size).toBe(0);
  });

  it("applies an endpoint's shorter retention", async () => {
    const userId = await createUser({ plan: "pro", request_limit: 100_000 });
    const short = await createEndpointForUser({ userId, name: "short" });
    const normal = await createEndpointForUser({ userId, name: "normal" });
    await admin.from("endpoints").update({ retention_days: 2 }).eq("id", short.id);
    const shortIds = await insertRequests(short.id, userId, [1, 3]);
    const normalIds = await insertRequests(normal.id, userId, [3]);
    await cleanup();
    expect(await remaining([...shortIds, ...normalIds])).toEqual(
      new Set([shortIds[0], normalIds[0]])
    );
  });

  it("hides rows past an endpoint's shorter retention before the cleanup reaches them", async () => {
    const userId = await createUser({ plan: "pro", request_limit: 100_000 });
    const short = await createEndpointForUser({ userId, name: "short reads" });
    await admin.from("endpoints").update({ retention_days: 2 }).eq("id", short.id);
    const [kept, old] = await insertRequests(short.id, userId, [1, 3]);
    // A team-billed row past the endpoint's days goes too (the cleanup deletes it).
    const { data: team, error } = await admin.rpc("create_team_with_owner", {
      p_user_id: userId,
      p_name: `Reads team ${ts}`,
    });
    if (error) throw error;
    const teamId = (team as { id: string }).id;
    createdTeamIds.push(teamId);
    const [teamOld] = await insertRequests(short.id, userId, [3], { team_id: teamId });

    expect(await getRequestByIdForUser(userId, kept)).not.toBeNull();
    expect(await getRequestByIdForUser(userId, old)).toBeNull();
    expect(await getRequestByIdForUser(userId, teamOld)).toBeNull();
    const listed = await listRequestsForEndpointByUser({ userId, slug: short.slug });
    expect(listed!.map((r) => r.id)).toEqual([kept]);
    const page = await listPaginatedRequestsForEndpointByUser({ userId, slug: short.slug });
    expect(page!.items.map((r) => r.id)).toEqual([kept]);
    const found = await searchRequestsForUser({ userId, plan: "pro", slug: short.slug });
    expect(found.map((r) => r.id)).toEqual([kept]);
    expect(await countSearchRequestsForUser({ userId, plan: "pro", slug: short.slug })).toBe(1);
    expect(await countSearchRequestsForUser({ userId, plan: "pro" })).toBe(1);
    // Replay and the previews read the same way: nothing past retention is resent or shown.
    expect(await requestIdsInRange(short.id, {})).toEqual([kept]);
    const retained = await getRetainedRequestsByIds(short.id, [kept, old, teamOld]);
    expect(retained.map((r) => r.id)).toEqual([kept]);
    expect(await getNewestRetainedRequestId(short.id, "http")).toBe(kept);
    const expiredOnly = await createEndpointForUser({ userId, name: "expired only" });
    await admin.from("endpoints").update({ retention_days: 2 }).eq("id", expiredOnly.id);
    await insertRequests(expiredOnly.id, userId, [3]);
    expect(await getNewestRetainedRequestId(expiredOnly.id, "http")).toBeNull();
  });

  it("does not let a page cursor reach past the plan's retention", async () => {
    const userId = await createUser({ plan: "pro", request_limit: 100_000 });
    const endpoint = await createEndpointForUser({ userId, name: "cursor" });
    // Pro keeps 30 days; a 40-day-old row is waiting for the cleanup.
    const [recent] = await insertRequests(endpoint.id, userId, [1]);
    await insertRequests(endpoint.id, userId, [40]);
    const forged = Buffer.from(JSON.stringify({ offset: 0, cutoff: 0 }), "utf8").toString(
      "base64url"
    );
    const page = await listPaginatedRequestsForEndpointByUser({
      userId,
      slug: endpoint.slug,
      cursor: forged,
    });
    expect(page!.items.map((r) => r.id)).toEqual([recent]);
  });

  it("keeps team-billed rows for the team's days, not the owner's", async () => {
    const owner = await createUser();
    const { data: team, error } = await admin.rpc("create_team_with_owner", {
      p_user_id: owner,
      p_name: `Retention team ${ts}`,
    });
    if (error) throw error;
    const teamId = (team as { id: string }).id;
    createdTeamIds.push(teamId);
    const endpoint = await createEndpointForUser({ userId: owner, name: "team billed" });
    const ids = await insertRequests(endpoint.id, owner, [10, 32], { team_id: teamId });
    await cleanup();
    // Free owner (7 days), team (31 days): the 10-day row stays.
    expect(await remaining(ids)).toEqual(new Set([ids[0]]));

    await admin.from("teams").update({ business: true }).eq("id", teamId);
    const more = await insertRequests(endpoint.id, owner, [60], { team_id: teamId });
    await cleanup();
    expect(await remaining(more)).toEqual(new Set(more));
  });

  it("deletes after delivery once nothing is pending", async () => {
    const userId = await createUser({ plan: "pro", request_limit: 100_000 });
    const endpoint = await createEndpointForUser({ userId, name: "deliver then delete" });
    await admin.from("endpoints").update({ delete_after_delivery: true }).eq("id", endpoint.id);
    const [old, fresh] = await insertRequests(endpoint.id, userId, [0.01, 0]);
    const { error } = await admin.from("email_deliveries").insert({
      request_id: old,
      endpoint_id: endpoint.id,
      status: "pending",
      kind: "http",
    });
    if (error) throw error;

    await admin.rpc("cleanup_delivered_requests", {});
    expect(await remaining([old, fresh])).toEqual(new Set([old, fresh]));

    await admin
      .from("email_deliveries")
      .update({ status: "succeeded", finished_at: new Date().toISOString() })
      .eq("request_id", old);
    await admin.rpc("cleanup_delivered_requests", {});
    // Kept a few minutes after its delivery finished, so alerts see it.
    expect(await remaining([old, fresh])).toEqual(new Set([old, fresh]));

    await admin
      .from("email_deliveries")
      .update({ finished_at: new Date(Date.now() - 4 * 60_000).toISOString() })
      .eq("request_id", old);
    await admin.rpc("cleanup_delivered_requests", {});
    // The fresh row is under a minute old and stays for the dashboard.
    expect(await remaining([old, fresh])).toEqual(new Set([fresh]));
  });
});

describe("periods", () => {
  it("renews an annual plan's quota every month while the year runs", async () => {
    const userId = await createUser({
      plan: "business",
      request_limit: 250_000,
      requests_used: 1234,
      subscription_status: "active",
      billing_interval: "year",
      period_start: daysAgo(31 + 31 + 5),
      // Two monthly periods missed: one pass lands on the current month.
      period_end: daysAgo(31 + 5),
      billing_period_end: inDays(200),
    });
    const { error } = await admin.rpc("process_billing_period_resets");
    if (error) throw error;
    const { data } = await admin
      .from("users")
      .select("plan, requests_used, period_start, period_end, billing_period_end")
      .eq("id", userId)
      .single();
    const user = data as Record<string, string | number>;
    expect(user.plan).toBe("business");
    expect(user.requests_used).toBe(0);
    const end = Date.parse(String(user.period_end));
    expect(end).toBeGreaterThan(Date.now());
    expect(end).toBeLessThan(Date.now() + 32 * DAY);
    expect(Date.parse(String(user.period_start))).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(String(user.billing_period_end))).toBeGreaterThan(Date.now() + 150 * DAY);
  });

  it("downgrades at the end of the billing period with a retention grace", async () => {
    const userId = await createUser({
      plan: "business",
      request_limit: 250_000,
      subscription_status: "active",
      cancel_at_period_end: true,
      billing_interval: "year",
      period_start: daysAgo(10),
      period_end: inDays(20),
      billing_period_end: daysAgo(1),
    });
    await admin.rpc("process_billing_period_resets");
    const { data } = await admin
      .from("users")
      .select("plan, request_limit, retention_floor_days, retention_floor_until, billing_interval")
      .eq("id", userId)
      .single();
    const user = data as Record<string, string | number | null>;
    expect(user.plan).toBe("free");
    expect(user.request_limit).toBe(ENTITLEMENTS.free.requestLimit);
    expect(user.billing_interval).toBeNull();
    expect(user.retention_floor_days).toBe(90);
    const until = Date.parse(String(user.retention_floor_until));
    expect(until).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(until).toBeLessThan(Date.now() + 8 * DAY);
  });

  it("keeps the grace on any downgrade path, and only for a downgrade", async () => {
    // A Polar revoke writes the plan directly; the trigger keeps the floor.
    const userId = await createUser({ plan: "pro", subscription_status: "active" });
    await admin.from("users").update({ plan: "free" }).eq("id", userId);
    const { data: user } = await admin
      .from("users")
      .select("retention_floor_days, retention_floor_until")
      .eq("id", userId)
      .single();
    expect(user?.retention_floor_days).toBe(ENTITLEMENTS.pro.retentionDays);
    expect(Date.parse(String(user?.retention_floor_until))).toBeGreaterThan(Date.now() + 6 * DAY);

    // An upgrade sets nothing.
    const upgraded = await createUser({ plan: "free" });
    await admin.from("users").update({ plan: "business" }).eq("id", upgraded);
    const { data: up } = await admin
      .from("users")
      .select("retention_floor_days")
      .eq("id", upgraded)
      .single();
    expect(up?.retention_floor_days).toBeNull();

    // Teams: dropping Team Business keeps its days.
    const { data: team, error } = await admin
      .from("teams")
      .insert({ name: `floor-${ts}`, created_by: userId, business: true })
      .select("id")
      .single();
    expect(error).toBeNull();
    await admin.from("teams").update({ business: false }).eq("id", team!.id);
    const { data: after } = await admin
      .from("teams")
      .select("retention_floor_days")
      .eq("id", team!.id)
      .single();
    expect(after?.retention_floor_days).toBe(ENTITLEMENTS.team_business.retentionDays);
    await admin.from("teams").delete().eq("id", team!.id);
  });

  it("starts lazy daily periods from the entitlements on capture", async () => {
    const userId = await createUser();
    const endpoint = await createEndpointForUser({ userId, name: "daily" });
    const { data, error } = await admin.rpc("capture_webhook", {
      p_slug: endpoint.slug,
      p_method: "POST",
      p_path: "/",
      p_headers: {},
      p_body: "{}",
      p_query_params: {},
      p_content_type: "application/json",
      p_ip: "127.0.0.1",
      p_received_at: new Date().toISOString(),
    });
    if (error) throw error;
    expect((data as { status: string }).status).toBe("ok");
    const { data: user } = await admin
      .from("users")
      .select("period_end, requests_used")
      .eq("id", userId)
      .single();
    const row = user as { period_end: string; requests_used: number };
    expect(row.requests_used).toBe(1);
    expect(Date.parse(row.period_end)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });
});

describe("capture_webhook with a request id and object prefix", () => {
  it("stores the id and prefix, and refuses a prefix for another id", async () => {
    const userId = await createUser({ plan: "pro", request_limit: 100_000 });
    const endpoint = await createEndpointForUser({ userId, name: "prefix" });
    const id = crypto.randomUUID();
    const base = {
      p_slug: endpoint.slug,
      p_method: "EMAIL",
      p_path: `${endpoint.slug}@mailhooks.cc`,
      p_headers: {},
      p_body: "raw",
      p_query_params: {},
      p_content_type: "message/rfc822",
      p_ip: "127.0.0.1",
      p_received_at: new Date().toISOString(),
      p_kind: "email",
      p_email: { subject: "s", attachments: [] },
    };
    const wrong = await admin.rpc("capture_webhook", {
      ...base,
      p_request_id: id,
      p_object_prefix: `m/${crypto.randomUUID()}/`,
    });
    expect(wrong.error?.code).toBe("22023");

    const ok = await admin.rpc("capture_webhook", {
      ...base,
      p_request_id: id,
      p_object_prefix: `m/${id}/`,
    });
    if (ok.error) throw ok.error;
    expect((ok.data as { request_id: string }).request_id).toBe(id);

    // Deleting the row queues its prefix for the storage deleter.
    await admin.from("requests").delete().eq("id", id);
    const { data: queued } = await admin
      .from("storage_deletions")
      .select("prefix")
      .eq("prefix", `m/${id}/`);
    expect(queued).toHaveLength(1);
    await admin.from("storage_deletions").delete().eq("prefix", `m/${id}/`);
  });
});

async function signedDeliver(payload: unknown) {
  const path = "/internal/mail/deliver";
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", SECRET!)
    .update(`${timestamp}.POST.${path}.`)
    .update(body)
    .digest("hex");
  return fetch(`${MAIL_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mail-timestamp": String(timestamp),
      "x-mail-signature": signature,
    },
    body,
  });
}

describe.skipIf(!isObjectStorageConfigured() || !SECRET)("object storage end to end", () => {
  it("keeps the exact message and each attachment, and deletes them with the row", async () => {
    const userId = await createUser({ plan: "pro", request_limit: 100_000 });
    const endpoint = await createEndpointForUser({ userId, name: "storage" });
    const csv = "sku,qty\nA-1,2\n";
    const raw = [
      "From: Acme <orders@acme.example>",
      `To: ${endpoint.slug}@mailhooks.cc`,
      "Subject: Order 1001",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "Order attached.",
      "--b1",
      "Content-Type: text/csv",
      'Content-Disposition: attachment; filename="order.csv"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(csv).toString("base64"),
      "--b1--",
      "",
    ].join("\r\n");
    const response = await signedDeliver({
      recipients: [`${endpoint.slug}@mailhooks.cc`],
      envelope_from: "orders@acme.example",
      client_ip: "192.0.2.25",
      received_at: new Date().toISOString(),
      retry: false,
      raw: Buffer.from(raw).toString("base64"),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      results: { status: string; request_id?: string }[];
    };
    expect(result.results[0].status).toBe("captured");
    const requestId = result.results[0].request_id!;

    const { data: row } = await admin
      .from("requests")
      .select("object_prefix, body_raw, email")
      .eq("id", requestId)
      .single();
    const stored = row as {
      object_prefix: string;
      body_raw: string | null;
      email: { raw_stored?: boolean };
    };
    expect(stored.object_prefix).toBe(`m/${requestId}/`);
    expect(stored.body_raw).toBeNull();
    expect(stored.email.raw_stored).toBe(true);

    expect((await getObjectBytes(`m/${requestId}/raw.eml`))?.toString("utf8")).toBe(raw);
    expect((await getObjectBytes(`m/${requestId}/a/0`))?.toString("utf8")).toBe(csv);

    await admin.from("requests").delete().eq("id", requestId);
    // Other suites may have queued prefixes too; drain until ours is gone.
    for (let i = 0; i < 20; i++) {
      const { data: queued } = await admin
        .from("storage_deletions")
        .select("id")
        .eq("prefix", `m/${requestId}/`);
      if (!queued || queued.length === 0) break;
      await deleteQueuedObjects(100);
    }
    expect(await listKeys(`m/${requestId}/`)).toEqual([]);
  });
});
