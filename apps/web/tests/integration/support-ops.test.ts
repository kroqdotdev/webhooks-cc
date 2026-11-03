import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { redeemRecoveryCode, replaceRecoveryCodes } from "@/lib/mfa-recovery";
import { owesSecondFactor, trustSession } from "@/lib/mfa-session";

/**
 * Migration 00087: staff on Business without a subscription, the ticket
 * lifecycle (replies, notes, notices, auto-close, reopening), grants and
 * the ops rollup.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ts = Date.now();
const userIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-support-${label}-${ts}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userIds.push(data.user!.id);
  return data.user!.id;
}

async function user(id: string) {
  const { data, error } = await admin
    .from("users")
    .select("plan, request_limit, cancel_at_period_end, period_end")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

async function newTicket(userId: string, grant = false) {
  const { data, error } = await admin.rpc("support_create_ticket", {
    p_user_id: userId,
    p_site: "webhooks",
    p_category: "bug",
    p_subject: "Signature fails",
    p_body: "Every event fails since this morning.",
    p_blocking: false,
    p_endpoint_id: null,
    p_notify: true,
    p_grant: grant,
    p_context: {},
  });
  if (error) throw error;
  return data![0] as { ticket_id: string; ticket_number: number; message_id: string };
}

async function ticket(id: string) {
  const { data, error } = await admin.from("support_tickets").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function notices(ticketId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("support_notifications")
    .select("kind")
    .eq("ticket_id", ticketId)
    .order("id");
  if (error) throw error;
  return (data ?? []).map((row) => row.kind);
}

let staffId: string;
let customerId: string;

beforeAll(async () => {
  staffId = await createUser("staff");
  customerId = await createUser("customer");
});

afterAll(async () => {
  await admin.from("staff").delete().in("user_id", userIds);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

describe("staff accounts", () => {
  it("are on Business without a subscription, and stay there", async () => {
    const { error } = await admin.from("staff").insert({ user_id: staffId });
    expect(error).toBeNull();
    const after = await user(staffId);
    expect(after.plan).toBe("business");
    expect(after.request_limit).toBe(250000);
    expect(after.period_end).not.toBeNull();

    // What a revoked subscription writes.
    await admin
      .from("users")
      .update({ plan: "free", request_limit: 50, cancel_at_period_end: true })
      .eq("id", staffId);
    const kept = await user(staffId);
    expect(kept.plan).toBe("business");
    expect(kept.request_limit).toBe(250000);
    expect(kept.cancel_at_period_end).toBe(false);
  });

  it("go back to free when removed", async () => {
    await admin.from("staff").delete().eq("user_id", staffId);
    const after = await user(staffId);
    expect(after.plan).toBe("free");
    expect(after.period_end).toBeNull();
  });
});

describe("support tickets", () => {
  it("waits on support, then on the user, and queues the right notices", async () => {
    const created = await newTicket(customerId);
    expect(created.ticket_number).toBeGreaterThan(1000);
    expect(await notices(created.ticket_id)).toEqual(["staff_new"]);

    await admin.rpc("support_post_message", {
      p_ticket_id: created.ticket_id,
      p_author: "staff",
      p_author_id: staffId,
      p_kind: "message",
      p_body: "Paste the secret again.",
    });
    // A second reply within the minute joins the first email.
    await admin.rpc("support_post_message", {
      p_ticket_id: created.ticket_id,
      p_author: "staff",
      p_author_id: staffId,
      p_kind: "message",
      p_body: "And send a test event.",
    });
    await admin.rpc("support_post_message", {
      p_ticket_id: created.ticket_id,
      p_author: "staff",
      p_author_id: staffId,
      p_kind: "note",
      p_body: "Stripe answers 400.",
    });
    const row = await ticket(created.ticket_id);
    expect(row.waiting_on).toBe("user");
    expect(await notices(created.ticket_id)).toEqual(["staff_new", "reply"]);

    const { data: messages } = await admin
      .from("support_messages")
      .select("kind")
      .eq("ticket_id", created.ticket_id);
    expect(messages!.filter((message) => message.kind === "note")).toHaveLength(1);
  });

  it("reminds after 3 days, closes after 7, and reopens on a reply", async () => {
    const created = await newTicket(customerId);
    await admin.rpc("support_post_message", {
      p_ticket_id: created.ticket_id,
      p_author: "staff",
      p_author_id: staffId,
      p_kind: "message",
      p_body: "Does it work now?",
    });
    await admin
      .from("support_tickets")
      .update({ waiting_since: new Date(Date.now() - 4 * 86_400_000).toISOString() })
      .eq("id", created.ticket_id);
    await admin.rpc("support_auto_close");
    expect((await ticket(created.ticket_id)).reminder_sent_at).not.toBeNull();

    await admin
      .from("support_tickets")
      .update({ waiting_since: new Date(Date.now() - 8 * 86_400_000).toISOString() })
      .eq("id", created.ticket_id);
    await admin.rpc("support_auto_close");
    const closed = await ticket(created.ticket_id);
    expect(closed.status).toBe("closed");
    expect(closed.closed_by).toBe("auto");
    expect(await notices(created.ticket_id)).toContain("closed");

    const { error } = await admin.rpc("support_post_message", {
      p_ticket_id: created.ticket_id,
      p_author: "user",
      p_author_id: customerId,
      p_kind: "message",
      p_body: "Still broken.",
    });
    expect(error).toBeNull();
    const reopened = await ticket(created.ticket_id);
    expect(reopened.status).toBe("open");
    expect(reopened.waiting_on).toBe("support");

    // Closed more than 30 days ago: the user opens a new ticket instead.
    await admin.rpc("support_close_ticket", {
      p_ticket_id: created.ticket_id,
      p_by: "staff",
      p_actor_id: staffId,
    });
    await admin
      .from("support_tickets")
      .update({ closed_at: new Date(Date.now() - 31 * 86_400_000).toISOString() })
      .eq("id", created.ticket_id);
    const late = await admin.rpc("support_post_message", {
      p_ticket_id: created.ticket_id,
      p_author: "user",
      p_author_id: customerId,
      p_kind: "message",
      p_body: "Hello again.",
    });
    expect(late.error?.message).toContain("ticket_closed");
  });

  it("only the owner changes access, and a withdrawal ends open views", async () => {
    const created = await newTicket(customerId, true);
    const { data: session } = await admin
      .from("support_view_sessions")
      .insert({
        staff_id: staffId,
        user_id: customerId,
        ticket_id: created.ticket_id,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      })
      .select("id")
      .single();

    const { data: wrongOwner } = await admin.rpc("support_set_access", {
      p_ticket_id: created.ticket_id,
      p_user_id: staffId,
      p_granted: false,
    });
    expect(wrongOwner).toBe(false);

    const { data: withdrawn } = await admin.rpc("support_set_access", {
      p_ticket_id: created.ticket_id,
      p_user_id: customerId,
      p_granted: false,
    });
    expect(withdrawn).toBe(true);
    const { data: ended } = await admin
      .from("support_view_sessions")
      .select("ended_at")
      .eq("id", session!.id)
      .single();
    expect(ended!.ended_at).not.toBeNull();
  });
});

describe("follow-ups", () => {
  it("a staff answer on a closed ticket reopens it and says so", async () => {
    const created = await newTicket(customerId);
    await admin.rpc("support_close_ticket", {
      p_ticket_id: created.ticket_id,
      p_by: "user",
      p_actor_id: customerId,
    });
    await admin.rpc("support_post_message", {
      p_ticket_id: created.ticket_id,
      p_author: "staff",
      p_author_id: staffId,
      p_kind: "message",
      p_body: "One more thing.",
    });
    const row = await ticket(created.ticket_id);
    expect(row.status).toBe("open");
    const { data: events } = await admin
      .from("support_messages")
      .select("event")
      .eq("ticket_id", created.ticket_id)
      .eq("kind", "event");
    expect(events!.map((event) => event.event)).toContain("reopened");
  });

  it("withdrawing on one ticket ends that ticket's views and logs it, not another's", async () => {
    const first = await newTicket(customerId, true);
    const second = await newTicket(customerId, true);
    const expires = new Date(Date.now() + 30 * 60_000).toISOString();
    const { data: sessions } = await admin
      .from("support_view_sessions")
      .insert([
        { staff_id: staffId, user_id: customerId, ticket_id: first.ticket_id, expires_at: expires },
        {
          staff_id: staffId,
          user_id: customerId,
          ticket_id: second.ticket_id,
          expires_at: expires,
        },
      ])
      .select("id, ticket_id");
    await admin.rpc("support_set_access", {
      p_ticket_id: first.ticket_id,
      p_user_id: customerId,
      p_granted: false,
    });
    const { data: after } = await admin
      .from("support_view_sessions")
      .select("ticket_id, ended_at")
      .in(
        "id",
        sessions!.map((session) => session.id)
      );
    const byTicket = new Map(after!.map((session) => [session.ticket_id, session.ended_at]));
    expect(byTicket.get(first.ticket_id)).not.toBeNull();
    expect(byTicket.get(second.ticket_id)).toBeNull();
    const { data: log } = await admin
      .from("support_access_log")
      .select("action")
      .eq("ticket_id", first.ticket_id);
    expect(log!.map((entry) => entry.action)).toContain("view_ended");
  });
});

describe("deleting", () => {
  it("deletes an account whose ticket has screenshots and queues their objects", async () => {
    const owner = await createUser("with-screenshot");
    const created = await newTicket(owner);
    await admin
      .from("support_tickets")
      .update({ has_attachments: true })
      .eq("id", created.ticket_id);
    const { error } = await admin.auth.admin.deleteUser(owner);
    expect(error).toBeNull();
    const { data } = await admin
      .from("storage_deletions")
      .select("id, prefix")
      .eq("prefix", `t/${created.ticket_id}/`);
    expect(data).toHaveLength(1);
    await admin.from("storage_deletions").delete().eq("id", data![0].id);
  });

  it("does not bring back access that ran out when a ticket reopens", async () => {
    const created = await newTicket(customerId, true);
    await admin.rpc("support_close_ticket", {
      p_ticket_id: created.ticket_id,
      p_by: "staff",
      p_actor_id: staffId,
    });
    await admin
      .from("support_tickets")
      .update({ closed_at: new Date(Date.now() - 20 * 86_400_000).toISOString() })
      .eq("id", created.ticket_id);
    await admin.rpc("support_post_message", {
      p_ticket_id: created.ticket_id,
      p_author: "user",
      p_author_id: customerId,
      p_kind: "message",
      p_body: "Thanks!",
    });
    const row = await ticket(created.ticket_id);
    expect(row.status).toBe("open");
    expect(row.access_granted).toBe(false);
  });
});

describe("ops rollup", () => {
  it("writes a day and can rewrite it", async () => {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect((await admin.rpc("ops_rollup_day", { p_day: day })).error).toBeNull();
    expect((await admin.rpc("ops_rollup_day", { p_day: day })).error).toBeNull();
    const { data } = await admin.from("ops_daily_metrics").select("day").eq("day", day);
    expect(data).toHaveLength(1);
    const today = await admin.rpc("ops_today");
    expect(today.error).toBeNull();
  });
});

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  }
  const key: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) key.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hmac = createHmac("sha1", Buffer.from(key)).update(counter).digest();
  const offset = hmac[19] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

describe("recovery codes", () => {
  it("work once and remove the authenticator", async () => {
    const email = `test-support-recovery-${ts}@webhooks-test.local`;
    const password = "TestPassword123!";
    const { data: created } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    const userId = created.user!.id;
    userIds.push(userId);

    // A real authenticator, enrolled and verified the way the browser does.
    const client = createClient(
      process.env.SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
      }
    );
    await client.auth.signInWithPassword({ email, password });
    const { data: factor, error: enrollError } = await client.auth.mfa.enroll({
      factorType: "totp",
    });
    expect(enrollError).toBeNull();
    const { error: verifyError } = await client.auth.mfa.challengeAndVerify({
      factorId: factor!.id,
      code: totp(factor!.totp.secret),
    });
    expect(verifyError).toBeNull();

    const codes = await replaceRecoveryCodes(userId);
    expect(codes).toHaveLength(10);
    expect(await redeemRecoveryCode(userId, "AAAAA-AAAAA")).toBe(false);
    expect(await redeemRecoveryCode(userId, codes[3].toLowerCase())).toBe(true);
    expect(await redeemRecoveryCode(userId, codes[3])).toBe(false);

    const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId });
    expect(factors!.factors.filter((entry) => entry.status === "verified")).toHaveLength(0);
    const { count } = await admin
      .from("mfa_recovery_codes")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    expect(count).toBe(0);
  });
});

describe("second factor carried by a site switch", () => {
  it("counts a trusted aal1 session as having passed it, until it signs out", async () => {
    const email = `test-support-switch-${ts}@webhooks-test.local`;
    const password = "TestPassword123!";
    const { data: created } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    const userId = created.user!.id;
    userIds.push(userId);
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const fresh = () =>
      createClient(process.env.SUPABASE_URL!, anon, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

    // An authenticator on the account.
    const setup = fresh();
    await setup.auth.signInWithPassword({ email, password });
    const { data: factor } = await setup.auth.mfa.enroll({ factorType: "totp" });
    await setup.auth.mfa.challengeAndVerify({
      factorId: factor!.id,
      code: totp(factor!.totp.secret),
    });

    // A new password-only session, as a switch's magic link makes.
    const other = fresh();
    const { data: signedIn } = await other.auth.signInWithPassword({ email, password });
    const token = signedIn.session!.access_token;
    const { data: user } = await admin.auth.getUser(token);
    const ownRow = async () => (await other.from("users").select("id").eq("id", userId)).data ?? [];

    expect(await owesSecondFactor(user.user!, token)).toBe(true);
    expect(await ownRow()).toHaveLength(0);

    await trustSession(token, userId);
    expect(await owesSecondFactor(user.user!, token)).toBe(false);
    expect(await ownRow()).toHaveLength(1);

    const trusted = async () =>
      (
        await admin
          .from("mfa_trusted_sessions")
          .select("session_id", { count: "exact", head: true })
          .eq("user_id", userId)
      ).count;

    // Removing the authenticator takes the carried trust with it.
    await admin.auth.admin.mfa.deleteFactor({ id: factor!.id, userId });
    expect(await trusted()).toBe(0);

    // Signing out ends the session and its trust with it.
    await trustSession(token, userId);
    expect(await trusted()).toBe(1);
    await other.auth.signOut();
    expect(await trusted()).toBe(0);
  });
});
