import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

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
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const createdUserIds: string[] = [];

interface ClaimedUser {
  id: string;
  email: string;
  home_site: string;
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function emailOf(label: string): string {
  return `test-welcome-claim-${label}-${ts}@webhooks-test.local`;
}

/** An account that signed up `age` ago, then the given state. */
async function createAccount(
  label: string,
  age: number,
  options: { confirmed?: boolean; state?: Record<string, unknown> } = {}
): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: emailOf(label),
    password: "TestPassword123!",
    email_confirm: options.confirmed ?? true,
  });
  if (error) throw error;
  const userId = data.user!.id;
  createdUserIds.push(userId);

  const { error: updateError } = await admin
    .from("users")
    .update({ created_at: ago(age), ...options.state })
    .eq("id", userId);
  if (updateError) throw updateError;
  return userId;
}

async function stateOf(userId: string) {
  const { data, error } = await admin
    .from("users")
    .select("welcome_email_sent_at, welcome_email_claimed_at")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data;
}

async function claimAll(): Promise<Map<string, ClaimedUser>> {
  // Large enough to reach past whatever else is due in the dev database.
  const { data, error } = await admin.rpc("claim_welcome_email_users", { p_limit: 10_000 });
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
      .update({ welcome_email_claimed_at: null })
      .in("id", others);
    if (releaseError) throw releaseError;
  }
  return ours;
}

afterAll(async () => {
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

describe("claim_welcome_email_users", () => {
  const ids: Record<string, string> = {};
  let claimed: Map<string, ClaimedUser>;

  beforeAll(async () => {
    ids.fresh = await createAccount("fresh", 5 * MINUTE_MS);
    ids.due = await createAccount("due", 31 * MINUTE_MS);
    ids.dueMail = await createAccount("due-mail", 2 * DAY_MS, {
      state: { home_site: "mailhooks" },
    });
    ids.lastDay = await createAccount("last-day", 7 * DAY_MS - 10 * MINUTE_MS);
    ids.tooOld = await createAccount("too-old", 7 * DAY_MS + 10 * MINUTE_MS);
    ids.unconfirmed = await createAccount("unconfirmed", 60 * MINUTE_MS, { confirmed: false });
    // What migration 00093 leaves on every account that existed before it.
    ids.existing = await createAccount("existing", 60 * MINUTE_MS, {
      state: { welcome_email_sent_at: ago(10 * MINUTE_MS) },
    });
    ids.leased = await createAccount("leased", 60 * MINUTE_MS, {
      state: { welcome_email_claimed_at: ago(5 * MINUTE_MS) },
    });
    ids.leaseExpired = await createAccount("lease-expired", 60 * MINUTE_MS, {
      state: { welcome_email_claimed_at: ago(16 * MINUTE_MS) },
    });
    claimed = await claimAll();
  });

  it("starts a new account without a welcome email on record", async () => {
    // The default that marks existing accounts must not reach new ones.
    const id = await createAccount("default", 0);
    expect(await stateOf(id)).toEqual({
      welcome_email_sent_at: null,
      welcome_email_claimed_at: null,
    });
  });

  it("claims confirmed accounts between 30 minutes and 7 days old", () => {
    expect(claimed.get(ids.due)).toEqual({
      id: ids.due,
      email: emailOf("due"),
      home_site: "webhooks",
    });
    expect(claimed.has(ids.lastDay)).toBe(true);
  });

  it("returns the account's site for the links", () => {
    expect(claimed.get(ids.dueMail)?.home_site).toBe("mailhooks");
  });

  it("waits 30 minutes after signup", () => {
    expect(claimed.has(ids.fresh)).toBe(false);
  });

  it("never claims an account older than 7 days", () => {
    expect(claimed.has(ids.tooOld)).toBe(false);
  });

  it("skips an account whose email is not confirmed, and claims it once it is", async () => {
    expect(claimed.has(ids.unconfirmed)).toBe(false);
    const { error } = await admin.auth.admin.updateUserById(ids.unconfirmed, {
      email_confirm: true,
    });
    if (error) throw error;
    expect((await claimAll()).has(ids.unconfirmed)).toBe(true);
  });

  it("never claims an account already marked as handled", () => {
    expect(claimed.has(ids.existing)).toBe(false);
  });

  it("respects a live lease and takes over an expired one", () => {
    expect(claimed.has(ids.leased)).toBe(false);
    expect(claimed.has(ids.leaseExpired)).toBe(true);
  });

  it("takes a lease, so a second poll does not claim the same account", async () => {
    const state = await stateOf(ids.due);
    expect(state.welcome_email_claimed_at).not.toBeNull();
    expect(state.welcome_email_sent_at).toBeNull();
    expect((await claimAll()).has(ids.due)).toBe(false);
  });

  it("claims again after the lease is released, as a failed send does", async () => {
    const { error } = await admin
      .from("users")
      .update({ welcome_email_claimed_at: null })
      .eq("id", ids.due);
    if (error) throw error;
    expect((await claimAll()).has(ids.due)).toBe(true);
  });

  it("honours the batch limit", async () => {
    const { data, error } = await admin.rpc("claim_welcome_email_users", { p_limit: 0 });
    if (error) throw error;
    expect(data).toEqual([]);
  });

  it("is never claimed again once marked sent, even with the lease gone", async () => {
    const { data: first, error } = await admin.rpc("mark_welcome_email_sent", {
      p_user_id: ids.due,
    });
    if (error) throw error;
    expect(first).toBe(true);
    const state = await stateOf(ids.due);
    expect(state.welcome_email_sent_at).not.toBeNull();
    expect(state.welcome_email_claimed_at).toBeNull();
    expect((await claimAll()).has(ids.due)).toBe(false);

    // A second mark answers false, so its caller does not send, and keeps the first time.
    const { data: second } = await admin.rpc("mark_welcome_email_sent", { p_user_id: ids.due });
    expect(second).toBe(false);
    expect((await stateOf(ids.due)).welcome_email_sent_at).toBe(state.welcome_email_sent_at);
  });

  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  it.skipIf(!anonKey)("is not callable by anon clients", async () => {
    const anon = createClient(SUPABASE_URL, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const claim = await anon.rpc("claim_welcome_email_users", { p_limit: 1 });
    expect(claim.error).not.toBeNull();
    const mark = await anon.rpc("mark_welcome_email_sent", { p_user_id: ids.fresh });
    expect(mark.error).not.toBeNull();
  });
});
