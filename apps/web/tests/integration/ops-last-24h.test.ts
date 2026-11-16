import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { createEndpointForUser } from "@/lib/supabase/endpoints";

/**
 * Migration 00111: the hourly snapshots behind the ops overview's "Last 24h"
 * column, and ops_last_24h(), which counts from the one nearest to 24 hours
 * ago. Other suites capture at the same time, so totals are checked against
 * the live counters read just before and just after the call.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
const DAY = 86_400_000;
const userIds: string[] = [];
const endpointIds: string[] = [];
const snapshots: string[] = [];

async function createUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-ops24-${label}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userIds.push(data.user!.id);
  return data.user!.id;
}

async function endpointFor(userId: string) {
  const endpoint = await createEndpointForUser({ userId, name: "ops 24h endpoint" });
  endpointIds.push(endpoint.id);
  return endpoint;
}

// All 10 parameters are named: the dev database still carries a legacy
// 9-argument overload (see supabase-team-quota.test.ts).
async function capture(slug: string, receivedAt = new Date()) {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
    p_method: "POST",
    p_path: "/",
    p_headers: { "content-type": "application/json" },
    p_body: "{}",
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "127.0.0.1",
    p_received_at: receivedAt.toISOString(),
    p_body_raw: null,
  });
  if (error) throw error;
  expect((data as { status: string }).status).toBe("ok");
}

const utcDay = (date: Date) => date.toISOString().slice(0, 10);

/** Live counters per account (guests as ""), staff and internal left out. */
async function liveCounts(fromDay: string): Promise<Map<string, number>> {
  const { data: excluded, error: excludedError } = await admin.rpc("ops_excluded_users");
  if (excludedError) throw excludedError;
  const skip = new Set((excluded ?? []).map((row: { user_id: string }) => row.user_id));
  const counts = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("endpoint_daily_stats")
      .select("user_id, captured")
      .gte("day", fromDay)
      .order("endpoint_id")
      .order("day")
      .range(from, from + 999);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.user_id && skip.has(row.user_id)) continue;
      const key = row.user_id ?? "";
      counts.set(key, (counts.get(key) ?? 0) + row.captured);
    }
    if (!data || data.length < 1000) break;
  }
  return counts;
}

async function insertSnapshot(at: Date, counts: { user_id: string | null; captured: number }[]) {
  const takenAt = at.toISOString();
  const { error } = await admin
    .from("ops_snapshots")
    .insert({ taken_at: takenAt, day: utcDay(at) });
  if (error) throw error;
  snapshots.push(takenAt);
  if (counts.length > 0) {
    const { error: countsError } = await admin
      .from("ops_snapshot_counts")
      .insert(counts.map((row) => ({ taken_at: takenAt, quota_rejected: 0, ...row })));
    if (countsError) throw countsError;
  }
  return takenAt;
}

/** Removes snapshots near 24 hours ago that another run or the dev server left. */
async function clearWindow() {
  const target = Date.now() - DAY;
  const { error } = await admin
    .from("ops_snapshots")
    .delete()
    .gte("taken_at", new Date(target - 2 * 3_600_000).toISOString())
    .lte("taken_at", new Date(target + 2 * 3_600_000).toISOString());
  if (error) throw error;
}

let userId: string;
let slug: string;

beforeAll(async () => {
  userId = await createUser("live");
  slug = (await endpointFor(userId)).slug;
});

afterAll(async () => {
  if (snapshots.length > 0) await admin.from("ops_snapshots").delete().in("taken_at", snapshots);
  if (endpointIds.length > 0) {
    await admin.from("endpoint_daily_stats").delete().in("endpoint_id", endpointIds);
    await admin.from("requests").delete().in("endpoint_id", endpointIds);
    await admin.from("endpoints").delete().in("id", endpointIds);
  }
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

describe("ops snapshots", () => {
  it("keep today's counters per account and the paying accounts", async () => {
    await capture(slug);
    await capture(slug);
    const { data: takenAt, error } = await admin.rpc("ops_take_snapshot");
    expect(error).toBeNull();
    snapshots.push(takenAt!);

    const { data: header } = await admin
      .from("ops_snapshots")
      .select("day")
      .eq("taken_at", takenAt!)
      .single();
    expect(header!.day).toBe(utcDay(new Date(takenAt!)));
    const { data: mine } = await admin
      .from("ops_snapshot_counts")
      .select("captured, quota_rejected")
      .eq("taken_at", takenAt!)
      .eq("user_id", userId);
    expect(mine).toEqual([{ captured: 2, quota_rejected: 0 }]);

    const { data: paidNow } = await admin.rpc("ops_paid_now");
    const { count } = await admin
      .from("ops_snapshot_paid")
      .select("account", { count: "exact", head: true })
      .eq("taken_at", takenAt!);
    expect(count).toBe(paidNow!.length);
  });

  it("drop snapshots older than three days", async () => {
    const old = await insertSnapshot(new Date(Date.now() - 4 * DAY), [
      { user_id: userId, captured: 1 },
    ]);
    const { data: takenAt } = await admin.rpc("ops_take_snapshot");
    snapshots.push(takenAt!);
    const { data } = await admin.from("ops_snapshots").select("taken_at").eq("taken_at", old);
    expect(data).toEqual([]);
    const { data: counts } = await admin
      .from("ops_snapshot_counts")
      .select("taken_at")
      .eq("taken_at", old);
    expect(counts).toEqual([]);
  });
});

describe("ops_last_24h", () => {
  it("answers dashes for the snapshot-based values without a snapshot near 24 hours ago", async () => {
    await clearWindow();
    // 100 minutes off is too far to stand for 24 hours ago.
    await insertSnapshot(new Date(Date.now() - DAY - 100 * 60_000), [
      { user_id: userId, captured: 0 },
    ]);
    const { data, error } = await admin.rpc("ops_last_24h");
    expect(error).toBeNull();
    const row = data![0];
    expect(row.snapshot_at).toBeNull();
    expect(row.captured).toBeNull();
    expect(row.quota_rejected).toBeNull();
    expect(row.active_accounts).toBeNull();
    expect(row.new_paid).toBeNull();
    expect(row.lost_paid).toBeNull();
    // Counted now, snapshot or not.
    expect(row.signups).toBeGreaterThanOrEqual(1);
    expect(row.paid_accounts).toBeGreaterThanOrEqual(0);
  });

  it("counts from the snapshot nearest to 24 hours ago", async () => {
    await clearWindow();
    const target = Date.now() - DAY;
    // Captures land on yesterday too, so the day split is exercised.
    await capture(slug, new Date(target + 10 * 60_000));
    await capture(slug);
    const fromDay = utcDay(new Date(target));
    const liveBefore = await liveCounts(fromDay);
    const mineLive = liveBefore.get(userId) ?? 0;
    expect(mineLive).toBeGreaterThanOrEqual(2);

    // Further away: never picked.
    await insertSnapshot(new Date(target + 50 * 60_000), [{ user_id: userId, captured: 0 }]);
    // The nearest: this account had three fewer captures then.
    const nearest = await insertSnapshot(new Date(target), [
      { user_id: userId, captured: mineLive - 3 },
    ]);
    const fake = `t:${randomUUID()}`;
    const { error: paidError } = await admin
      .from("ops_snapshot_paid")
      .insert({ taken_at: nearest, account: fake });
    expect(paidError).toBeNull();

    const { data, error } = await admin.rpc("ops_last_24h");
    expect(error).toBeNull();
    const liveAfter = await liveCounts(fromDay);
    const row = data![0];
    expect(new Date(row.snapshot_at!).getTime()).toBe(new Date(nearest).getTime());

    // Everything live since the snapshot's day, less what the snapshot held.
    const total = (counts: Map<string, number>) =>
      [...counts.values()].reduce((sum, value) => sum + value, 0);
    const low = Math.min(total(liveBefore), total(liveAfter)) - (mineLive - 3);
    const high = Math.max(total(liveBefore), total(liveAfter)) - (mineLive - 3);
    expect(Number(row.captured)).toBeGreaterThanOrEqual(low);
    expect(Number(row.captured)).toBeLessThanOrEqual(high);

    // Every account with a capture since then, this one included; guests are
    // not accounts.
    const accounts = (counts: Map<string, number>) =>
      [...counts.entries()].filter(([key, value]) => key !== "" && value > 0).length;
    expect(Number(row.active_accounts)).toBeGreaterThanOrEqual(
      Math.min(accounts(liveBefore), accounts(liveAfter))
    );
    expect(Number(row.active_accounts)).toBeLessThanOrEqual(
      Math.max(accounts(liveBefore), accounts(liveAfter))
    );

    // The snapshot held only an account that no longer pays.
    expect(Number(row.lost_paid)).toBe(1);
    expect(Number(row.new_paid)).toBe(Number(row.paid_accounts));
  });

  it("counts signups and the activation cohort over exact windows", async () => {
    const cohortId = await createUser("cohort");
    const signedUp = new Date(Date.now() - 7.5 * DAY);
    const { error } = await admin
      .from("users")
      .update({ created_at: signedUp.toISOString() })
      .eq("id", cohortId);
    expect(error).toBeNull();
    const cohortSlug = (await endpointFor(cohortId)).slug;
    // Activated on their second day.
    await capture(cohortSlug, new Date(signedUp.getTime() + DAY));

    const { data } = await admin.rpc("ops_last_24h");
    const row = data![0];
    expect(Number(row.cohort_signups)).toBeGreaterThanOrEqual(1);
    expect(Number(row.cohort_activated)).toBeGreaterThanOrEqual(1);
    expect(Number(row.cohort_activated)).toBeLessThanOrEqual(Number(row.cohort_signups));
    // The account made in beforeAll, a moment ago; the cohort one is 7 days old.
    expect(Number(row.signups)).toBeGreaterThanOrEqual(1);
  });
});
