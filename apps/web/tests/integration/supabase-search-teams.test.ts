/**
 * Search across endpoints shared through teams (migration 00039).
 *
 * search_requests / search_requests_count must show a team member the rows
 * on endpoints shared with a subscribed team they belong to, hide them again
 * when the team lapses, and never show them to a non-member. Retention: the
 * searcher's personal 7-day window applies only to their own non-team-billed
 * rows; rows on shared endpoints are bounded by the owner's cleanup instead.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createEndpointForUser } from "@/lib/supabase/endpoints";
import { countSearchRequestsForUser, searchRequestsForUser } from "@/lib/supabase/search";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
const PASSWORD = "TestPassword123!";
const OWNER_EMAIL = `test-search-team-owner-${ts}@webhooks-test.local`;
const MEMBER_EMAIL = `test-search-team-member-${ts}@webhooks-test.local`;
const OUTSIDER_EMAIL = `test-search-team-outsider-${ts}@webhooks-test.local`;
const MARKER = `shared-marker-${ts}`;

let ownerId: string;
let memberId: string;
let outsiderId: string;
let teamId: string;
let sharedSlug: string;
let sharedEndpointId: string;
let privateSlug: string;

async function createTestUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: email.split("@")[0] },
  });
  if (error) throw error;
  return data.user!.id;
}

async function setTeamActive(active: boolean): Promise<void> {
  const { error } = await admin
    .from("teams")
    .update(
      active
        ? {
            subscription_status: "active",
            seats: 2,
            request_limit: 200_000,
            requests_used: 0,
            period_start: new Date().toISOString(),
            period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          }
        : { subscription_status: null }
    )
    .eq("id", teamId);
  if (error) throw error;
}

async function insertRequest(input: {
  endpointId: string;
  userId: string;
  path: string;
  receivedAt: number;
  teamId?: string;
}): Promise<void> {
  const { error } = await admin.from("requests").insert({
    endpoint_id: input.endpointId,
    user_id: input.userId,
    team_id: input.teamId ?? null,
    method: "POST",
    path: input.path,
    headers: { "content-type": "application/json" },
    body: `{"marker":"${MARKER}"}`,
    query_params: {},
    content_type: "application/json",
    ip: "127.0.0.1",
    size: 20,
    received_at: new Date(input.receivedAt).toISOString(),
  });
  if (error) throw error;
}

describe("Search across team-shared endpoints", () => {
  beforeAll(async () => {
    ownerId = await createTestUser(OWNER_EMAIL);
    memberId = await createTestUser(MEMBER_EMAIL);
    outsiderId = await createTestUser(OUTSIDER_EMAIL);

    const { data: team, error: teamError } = await admin
      .from("teams")
      .insert({ name: `Search Team ${ts}`, created_by: ownerId })
      .select("id")
      .single();
    if (teamError) throw teamError;
    teamId = team.id;

    const { error: membersError } = await admin.from("team_members").insert([
      { team_id: teamId, user_id: ownerId, role: "owner" },
      { team_id: teamId, user_id: memberId, role: "member" },
    ]);
    if (membersError) throw membersError;
    await setTeamActive(true);

    const shared = await createEndpointForUser({ userId: ownerId, name: "shared" });
    sharedSlug = shared.slug;
    sharedEndpointId = shared.id;
    const priv = await createEndpointForUser({ userId: ownerId, name: "private" });
    privateSlug = priv.slug;

    const { error: shareError } = await admin
      .from("team_endpoints")
      .insert({ team_id: teamId, endpoint_id: sharedEndpointId, shared_by: ownerId });
    if (shareError) throw shareError;

    const now = Date.now();
    // Two team-billed rows on the shared endpoint, one of them older than the
    // free 7-day window, plus one recent row billed to the owner personally.
    await insertRequest({
      endpointId: sharedEndpointId,
      userId: ownerId,
      path: "/shared/recent",
      receivedAt: now - 60_000,
      teamId,
    });
    await insertRequest({
      endpointId: sharedEndpointId,
      userId: ownerId,
      path: "/shared/old",
      receivedAt: now - 20 * 86_400_000,
      teamId,
    });
    await insertRequest({
      endpointId: sharedEndpointId,
      userId: ownerId,
      path: "/shared/owner-billed",
      receivedAt: now - 120_000,
    });
    // Owner-billed and older than the free owner's 7-day window: the request
    // routes hide it from everyone, so search must too, whatever the
    // searcher's own plan.
    await insertRequest({
      endpointId: sharedEndpointId,
      userId: ownerId,
      path: "/shared/owner-billed-expired",
      receivedAt: now - 10 * 86_400_000,
    });
    // A row on the owner's unshared endpoint must never reach the member.
    await insertRequest({
      endpointId: priv.id,
      userId: ownerId,
      path: "/private/recent",
      receivedAt: now - 30_000,
    });
  });

  // Every test assumes the share exists; the last one removes it. Restoring
  // it after each test keeps the suite order-independent (--sequence.shuffle).
  afterEach(async () => {
    const { error } = await admin
      .from("team_endpoints")
      .upsert(
        { team_id: teamId, endpoint_id: sharedEndpointId, shared_by: ownerId },
        { onConflict: "team_id,endpoint_id", ignoreDuplicates: true }
      );
    if (error) throw error;
  });

  afterAll(async () => {
    if (teamId) await admin.from("teams").delete().eq("id", teamId);
    for (const id of [ownerId, memberId, outsiderId]) {
      if (id) await admin.auth.admin.deleteUser(id);
    }
  });

  it("shows a member every row on the shared endpoint and nothing private", async () => {
    const results = await searchRequestsForUser({ userId: memberId, plan: "free", q: MARKER });
    const paths = results.map((r) => r.path).sort();

    expect(paths).toEqual(["/shared/old", "/shared/owner-billed", "/shared/recent"]);
    expect(results.every((r) => r.slug === sharedSlug)).toBe(true);

    const count = await countSearchRequestsForUser({ userId: memberId, plan: "free", q: MARKER });
    expect(count).toBe(3);
  });

  it("honours the slug filter for a member", async () => {
    const shared = await searchRequestsForUser({ userId: memberId, slug: sharedSlug, q: MARKER });
    expect(shared).toHaveLength(3);

    const priv = await searchRequestsForUser({ userId: memberId, slug: privateSlug, q: MARKER });
    expect(priv).toEqual([]);
    expect(await countSearchRequestsForUser({ userId: memberId, slug: privateSlug })).toBe(0);
  });

  it("keeps the owner's own view unchanged, including the free retention carve-out", async () => {
    const results = await searchRequestsForUser({ userId: ownerId, plan: "free", q: MARKER });
    const paths = results.map((r) => r.path).sort();

    // Team-billed rows survive the 7-day window; the owner-billed rows are recent anyway.
    expect(paths).toEqual([
      "/private/recent",
      "/shared/old",
      "/shared/owner-billed",
      "/shared/recent",
    ]);
    expect(await countSearchRequestsForUser({ userId: ownerId, plan: "free", q: MARKER })).toBe(4);
  });

  it("applies the endpoint owner's retention to shared rows, not the searcher's plan", async () => {
    // A Pro member still does not see the free owner's expired owner-billed row.
    const asPro = await searchRequestsForUser({ userId: memberId, plan: "pro", q: MARKER });
    expect(asPro.map((r) => r.path)).not.toContain("/shared/owner-billed-expired");
    expect(asPro).toHaveLength(3);

    // Once the owner is on Pro, the same row is inside the owner's window.
    // The owner is deleted in afterAll, so a failed assertion cannot leak the
    // plan change past this file.
    const { error } = await admin.from("users").update({ plan: "pro" }).eq("id", ownerId);
    if (error) throw error;
    const results = await searchRequestsForUser({ userId: memberId, plan: "free", q: MARKER });
    const count = await countSearchRequestsForUser({ userId: memberId, q: MARKER });
    const { error: resetError } = await admin
      .from("users")
      .update({ plan: "free" })
      .eq("id", ownerId);
    if (resetError) throw resetError;

    expect(results.map((r) => r.path)).toContain("/shared/owner-billed-expired");
    expect(count).toBe(4);
  });

  it("shows a non-member nothing", async () => {
    expect(await searchRequestsForUser({ userId: outsiderId, q: MARKER })).toEqual([]);
    expect(await countSearchRequestsForUser({ userId: outsiderId, q: MARKER })).toBe(0);
  });

  it("hides shared rows from the member while the team is suspended", async () => {
    await setTeamActive(false);
    try {
      expect(await searchRequestsForUser({ userId: memberId, q: MARKER })).toEqual([]);
      expect(await countSearchRequestsForUser({ userId: memberId, q: MARKER })).toBe(0);
    } finally {
      await setTeamActive(true);
    }

    expect(await countSearchRequestsForUser({ userId: memberId, q: MARKER })).toBe(3);
  });

  it("hides shared rows once the share is removed", async () => {
    const { error } = await admin
      .from("team_endpoints")
      .delete()
      .eq("team_id", teamId)
      .eq("endpoint_id", sharedEndpointId);
    if (error) throw error;

    expect(await countSearchRequestsForUser({ userId: memberId, q: MARKER })).toBe(0);
    expect(await countSearchRequestsForUser({ userId: ownerId, q: MARKER })).toBe(4);
  });
});
