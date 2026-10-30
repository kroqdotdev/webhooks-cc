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
const DAY_MS = 24 * 60 * 60_000;
const createdUserIds: string[] = [];
const createdEndpointIds: string[] = [];
const createdTeamIds: string[] = [];
const endpointOf = new Map<string, string>();

interface ClaimedUser {
  id: string;
  email: string;
  plan: string;
  request_limit: number;
  block_requests: number;
  period_end: string;
  cancel_at_period_end: boolean;
  overage_active: boolean;
  team_billed_endpoints: number;
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// One instant, so overage_period_start can equal it (overage_used counts only then).
const PRO_PERIOD_START = ago(10 * DAY_MS);

/** A user with one owned endpoint, then the given account state. */
async function createAccount(label: string, state: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-quota-claim-${label}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  const userId = data.user!.id;
  createdUserIds.push(userId);

  const endpoint = await createEndpointForUser({ userId, name: "quota claim endpoint" });
  createdEndpointIds.push(endpoint.id);
  endpointOf.set(userId, endpoint.id);

  const { error: updateError } = await admin.from("users").update(state).eq("id", userId);
  if (updateError) throw updateError;
  return userId;
}

/** A free account at its limit, in a period that began a moment ago. */
function freeCapped(extra: Record<string, unknown> = {}) {
  return {
    plan: "free",
    request_limit: 50,
    requests_used: 50,
    period_start: ago(60_000),
    period_end: new Date(Date.now() + 60 * 60_000).toISOString(),
    ...extra,
  };
}

/** A Pro account at its limit, ten days into a 30-day period. */
function proCapped(extra: Record<string, unknown> = {}) {
  return {
    plan: "pro",
    subscription_status: "active",
    request_limit: 100_000,
    requests_used: 100_000,
    period_start: PRO_PERIOD_START,
    period_end: new Date(Date.now() + 20 * DAY_MS).toISOString(),
    ...extra,
  };
}

/** Shares the user's endpoint into a new subscribed team owned by them. */
async function billToTeam(userId: string, label: string) {
  const { data, error } = await admin.rpc("create_team_with_owner", {
    p_user_id: userId,
    p_name: `QuotaClaim ${label} ${ts}`,
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
      period_end: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      polar_subscription_id: `sub_quota_claim_${label}_${ts}`,
    })
    .eq("id", teamId);
  if (activateError) throw activateError;

  const { error: shareError } = await admin
    .from("team_endpoints")
    .insert({ team_id: teamId, endpoint_id: endpointOf.get(userId), shared_by: userId });
  if (shareError) throw shareError;
}

async function claimAll(): Promise<Map<string, ClaimedUser>> {
  // Large enough to reach past whatever else is exhausted in the dev database.
  const { data, error } = await admin.rpc("claim_quota_exhausted_users", { p_limit: 10_000 });
  if (error) throw error;
  const ours = new Map<string, ClaimedUser>();
  const others: string[] = [];
  for (const row of (data ?? []) as ClaimedUser[]) {
    if (createdUserIds.includes(row.id)) ours.set(row.id, row);
    else others.push(row.id);
  }
  // Hand back the leases taken on other dev accounts, so a running dev poller
  // is not held off them for 15 minutes.
  if (others.length > 0) {
    const { error: releaseError } = await admin
      .from("users")
      .update({ quota_email_claimed_at: null })
      .in("id", others);
    if (releaseError) throw releaseError;
  }
  return ours;
}

afterAll(async () => {
  if (createdEndpointIds.length > 0) {
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

describe("claim_quota_exhausted_users", () => {
  const ids: Record<string, string> = {};
  let claimed: Map<string, ClaimedUser>;

  beforeAll(async () => {
    ids.free = await createAccount("free", freeCapped());
    ids.freeEmailedRecently = await createAccount(
      "free-recent",
      freeCapped({ quota_email_sent_at: ago(3 * DAY_MS) })
    );
    ids.freeEmailedLastWeek = await createAccount(
      "free-week",
      freeCapped({ quota_email_sent_at: ago(8 * DAY_MS) })
    );
    ids.freeWithCredits = await createAccount("free-credits", freeCapped({ credit_requests: 10 }));
    ids.pro = await createAccount("pro", proCapped());
    ids.proEmailedWhileFree = await createAccount(
      "pro-was-free",
      proCapped({ quota_email_sent_at: ago(12 * DAY_MS) })
    );
    ids.proEmailedThisPeriod = await createAccount(
      "pro-this-period",
      proCapped({ quota_email_sent_at: ago(8 * DAY_MS) })
    );
    ids.proEnding = await createAccount(
      "pro-ending",
      proCapped({ cancel_at_period_end: true, block_requests: 25_000, requests_used: 125_000 })
    );
    ids.proWithBlocksLeft = await createAccount(
      "pro-blocks",
      proCapped({ block_requests: 25_000 })
    );
    ids.proWithCredits = await createAccount("pro-credits", proCapped({ credit_requests: 1 }));
    ids.proOverageRoom = await createAccount(
      "pro-overage-room",
      proCapped({
        overage_active: true,
        overage_max: 25_000,
        overage_used: 24_999,
        overage_period_start: PRO_PERIOD_START,
      })
    );
    ids.proOverageFull = await createAccount(
      "pro-overage-full",
      proCapped({
        overage_active: true,
        overage_max: 25_000,
        overage_used: 25_000,
        overage_period_start: PRO_PERIOD_START,
      })
    );
    ids.proOverageLastPeriod = await createAccount(
      "pro-overage-last-period",
      proCapped({
        overage_active: true,
        overage_max: 25_000,
        overage_used: 25_000,
        overage_period_start: ago(40 * DAY_MS),
      })
    );
    ids.proNoPeriodStart = await createAccount(
      "pro-no-start",
      proCapped({ period_start: null, quota_email_sent_at: ago(8 * DAY_MS) })
    );
    ids.proNoPeriodStartRecent = await createAccount(
      "pro-no-start-recent",
      proCapped({ period_start: null, quota_email_sent_at: ago(3 * DAY_MS) })
    );
    ids.proTeamBilledOnly = await createAccount("pro-team-billed", proCapped());
    await billToTeam(ids.proTeamBilledOnly, "team-billed");
    // Free, so the per-minute reset job (which renews Pro periods that have
    // ended) cannot reset it before the claim and make the check vacuous.
    ids.periodOver = await createAccount(
      "period-over",
      freeCapped({ period_start: ago(2 * DAY_MS), period_end: ago(DAY_MS) })
    );

    claimed = await claimAll();
  });

  it("claims a free account at its limit, as before", () => {
    expect(claimed.get(ids.free)).toMatchObject({ plan: "free", request_limit: 50 });
  });

  it("keeps the weekly window for free accounts", () => {
    expect(claimed.has(ids.freeEmailedRecently)).toBe(false);
    expect(claimed.has(ids.freeEmailedLastWeek)).toBe(true);
  });

  it("claims a Pro account past its allowance with nothing extra left", () => {
    expect(claimed.get(ids.pro)).toMatchObject({
      plan: "pro",
      request_limit: 100_000,
      block_requests: 0,
      cancel_at_period_end: false,
      overage_active: false,
      team_billed_endpoints: 0,
    });
    expect(claimed.get(ids.proOverageFull)).toMatchObject({ overage_active: true });
  });

  it("returns the recurring blocks and whether the plan is ending", () => {
    expect(claimed.get(ids.proEnding)).toMatchObject({
      plan: "pro",
      block_requests: 25_000,
      cancel_at_period_end: true,
    });
  });

  it("skips accounts that capture_webhook() would still take requests for", () => {
    expect(claimed.has(ids.freeWithCredits)).toBe(false);
    expect(claimed.has(ids.proWithBlocksLeft)).toBe(false);
    expect(claimed.has(ids.proWithCredits)).toBe(false);
    expect(claimed.has(ids.proOverageRoom)).toBe(false);
    // Overage used up in an earlier period counts as room in this one.
    expect(claimed.has(ids.proOverageLastPeriod)).toBe(false);
    expect(claimed.has(ids.periodOver)).toBe(false);
  });

  it("skips an account whose endpoints are all billed to a team", () => {
    expect(claimed.has(ids.proTeamBilledOnly)).toBe(false);
  });

  it("emails a paid account once per billing period", () => {
    // Emailed while free, before this period began: due again.
    expect(claimed.has(ids.proEmailedWhileFree)).toBe(true);
    // Emailed eight days ago, within this period: not again until it renews.
    expect(claimed.has(ids.proEmailedThisPeriod)).toBe(false);
  });

  it("falls back to the weekly window for a paid account without a period start", () => {
    expect(claimed.has(ids.proNoPeriodStart)).toBe(true);
    expect(claimed.has(ids.proNoPeriodStartRecent)).toBe(false);
  });

  it("does not claim an account again while its lease holds or once it was emailed", async () => {
    const { error } = await admin.rpc("mark_quota_email_sent", { p_user_id: ids.pro });
    if (error) throw error;

    // The mark releases the lease, so only the email time keeps it out below.
    const { data: row, error: readError } = await admin
      .from("users")
      .select("quota_email_sent_at, quota_email_claimed_at")
      .eq("id", ids.pro)
      .single();
    if (readError) throw readError;
    expect(row.quota_email_sent_at).not.toBeNull();
    expect(row.quota_email_claimed_at).toBeNull();

    const again = await claimAll();
    expect(again.has(ids.pro)).toBe(false);
    // Claimed in beforeAll and never marked: its lease still holds.
    expect(again.has(ids.free)).toBe(false);
  });

  it("dates the email from the claim, so a renewal before the mark keeps its own email", async () => {
    const renewing = await createAccount("pro-renews-mid-send", proCapped());
    expect((await claimAll()).has(renewing)).toBe(true);

    // The period renews between the claim and the send.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const renewedStart = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { error: renewError } = await admin
      .from("users")
      .update({
        requests_used: 0,
        period_start: renewedStart,
        period_end: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      })
      .eq("id", renewing);
    if (renewError) throw renewError;

    const { error } = await admin.rpc("mark_quota_email_sent", { p_user_id: renewing });
    if (error) throw error;
    const { data: row, error: readError } = await admin
      .from("users")
      .select("quota_email_sent_at")
      .eq("id", renewing)
      .single();
    if (readError) throw readError;
    expect(Date.parse(row.quota_email_sent_at!)).toBeLessThan(Date.parse(renewedStart));
  });
});

describe("claim_quota_exhausted_users access", () => {
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  it.skipIf(!anonKey)("is not callable by anon clients", async () => {
    const anon = createClient(SUPABASE_URL, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await anon.rpc("claim_quota_exhausted_users", { p_limit: 1 });
    expect(error).not.toBeNull();
  });
});
