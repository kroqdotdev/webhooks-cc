/**
 * Email/password auth against the dev Supabase instance.
 *
 * Environmental requirements beyond the usual env vars (like the
 * receiver-dependent suites): the dev GoTrue must carry the email-auth config
 * from infra/supabase/gotrue-email-auth.md (password min length 8, real SMTP,
 * the before-user-created hook from migration 00052) and the `supabase-mail`
 * Inbucket container must be up, because anon signUp sends a confirmation
 * email and fails at the SMTP hop without it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createClient, isAuthSessionMissingError } from "@supabase/supabase-js";
import { createInvite, createTeam, deleteTeam } from "@/lib/supabase/teams";
import type { Database } from "@/lib/supabase/database";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}
if (!ANON_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Fresh anon client per call so sessions never leak between steps. */
function anonClient() {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const ts = Date.now();
const VALID_PASSWORD = "a-valid-password";
const SIGNUP_EMAIL = `test-email-auth-${ts}@webhooks-test.local`;
const INVITEE_EMAIL = `test-email-auth-invitee-${ts}@webhooks-test.local`;
const OWNER_EMAIL = `test-email-auth-owner-${ts}@webhooks-test.local`;

const createdUserIds: string[] = [];
let signupUserId: string;
let ownerId: string;
let teamId: string;

describe("Email/password auth", () => {
  afterAll(async () => {
    if (teamId && ownerId) {
      await deleteTeam(ownerId, teamId);
    }
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  describe("signup", () => {
    it("returns an unconfirmed user without a session and creates the public.users row", async () => {
      const { data, error } = await anonClient().auth.signUp({
        email: SIGNUP_EMAIL,
        password: VALID_PASSWORD,
      });

      expect(error).toBeNull();
      expect(data.user).toBeTruthy();
      expect(data.user!.email_confirmed_at ?? null).toBeNull();
      expect(data.session).toBeNull();

      signupUserId = data.user!.id;
      createdUserIds.push(signupUserId);

      // handle_new_user fires on auth.users INSERT, i.e. at signup, not at
      // confirmation: the profile exists before the email is confirmed.
      const { data: profile, error: profileError } = await admin
        .from("users")
        .select("id, email, plan")
        .eq("id", signupUserId)
        .single();

      expect(profileError).toBeNull();
      expect(profile!.email).toBe(SIGNUP_EMAIL);
      expect(profile!.plan).toBe("free");
    });

    it("rejects a 7-character password (GOTRUE_PASSWORD_MIN_LENGTH=8 on the instance)", async () => {
      const { data, error } = await anonClient().auth.signUp({
        email: `test-email-auth-short-${ts}@webhooks-test.local`,
        password: "1234567",
      });

      expect(data.user).toBeNull();
      expect(error).toBeTruthy();
      expect(error!.code).toBe("weak_password");
    });

    it("refuses an address at the capture domain (before-user-created hook, 00052)", async () => {
      const { data, error } = await anonClient().auth.signUp({
        email: `test-email-auth-${ts}+tag@mailhooks.cc`,
        password: VALID_PASSWORD,
      });

      expect(data.user).toBeNull();
      expect(error).toBeTruthy();
      expect(error!.status).toBe(403);
      expect(error!.message).toContain("mailhooks.cc");
    });

    it("refuses a capture-domain address for magic link signup too", async () => {
      const { error } = await anonClient().auth.signInWithOtp({
        email: `test-email-auth-otp-${ts}@MailHooks.CC`,
        options: { shouldCreateUser: true },
      });

      expect(error).toBeTruthy();
      expect(error!.status).toBe(403);
      expect(error!.message).toContain("mailhooks.cc");
    });

    it("rejects signInWithPassword before the email is confirmed", async () => {
      const { data, error } = await anonClient().auth.signInWithPassword({
        email: SIGNUP_EMAIL,
        password: VALID_PASSWORD,
      });

      expect(data.session).toBeNull();
      expect(error).toBeTruthy();
      expect(error!.code).toBe("email_not_confirmed");
    });

    it("accepts signInWithPassword once the email is confirmed", async () => {
      const { error: confirmError } = await admin.auth.admin.updateUserById(signupUserId, {
        email_confirm: true,
      });
      expect(confirmError).toBeNull();

      const { data, error } = await anonClient().auth.signInWithPassword({
        email: SIGNUP_EMAIL,
        password: VALID_PASSWORD,
      });

      expect(error).toBeNull();
      expect(data.session).toBeTruthy();
      expect(data.user!.id).toBe(signupUserId);
    });
  });

  describe("invite linking through real signup", () => {
    it("links a pending invite to the account created by anon signUp with that email", async () => {
      const { data: ownerData, error: ownerError } = await admin.auth.admin.createUser({
        email: OWNER_EMAIL,
        password: VALID_PASSWORD,
        email_confirm: true,
      });
      expect(ownerError).toBeNull();
      ownerId = ownerData.user!.id;
      createdUserIds.push(ownerId);

      const teamResult = await createTeam(ownerId, "Email Auth Team");
      expect("error" in teamResult).toBe(false);
      teamId = (teamResult as Exclude<typeof teamResult, { error: string }>).id;

      // Put the team on an active subscription with a free seat; no Polar
      // subscription id, so seat assignment short-circuits before any HTTP.
      const { error: activateError } = await admin
        .from("teams")
        .update({
          subscription_status: "active",
          seats: 2,
          request_limit: 200_000,
          requests_used: 0,
          period_start: new Date().toISOString(),
          period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          polar_subscription_id: null,
        })
        .eq("id", teamId);
      expect(activateError).toBeNull();

      const inviteResult = await createInvite(ownerId, teamId, INVITEE_EMAIL);
      expect(inviteResult.error).toBeUndefined();
      expect(inviteResult.invite).toBeDefined();
      const inviteId = inviteResult.invite!.id;

      const { data: before } = await admin
        .from("team_invites")
        .select("invited_user_id, status")
        .eq("id", inviteId)
        .single();
      expect(before!.invited_user_id).toBeNull();
      expect(before!.status).toBe("pending");

      // The invitee signs up through the public signUp path, exactly as an
      // email/password user would from the login form.
      const { data: signup, error: signupError } = await anonClient().auth.signUp({
        email: INVITEE_EMAIL,
        password: VALID_PASSWORD,
      });
      expect(signupError).toBeNull();
      const inviteeId = signup.user!.id;
      createdUserIds.push(inviteeId);

      const { data: after } = await admin
        .from("team_invites")
        .select("invited_user_id, status")
        .eq("id", inviteId)
        .single();
      expect(after!.invited_user_id).toBe(inviteeId);
      expect(after!.status).toBe("pending");
    });
  });

  describe("recovery via token hash (what /auth/confirm relies on)", () => {
    it("verifyOtp with a recovery hash yields a session that can set a new password", async () => {
      const NEW_PASSWORD = "a-brand-new-password";

      const { data: link, error: linkError } = await admin.auth.admin.generateLink({
        type: "recovery",
        email: SIGNUP_EMAIL,
      });
      expect(linkError).toBeNull();
      const tokenHash = link.properties!.hashed_token;
      expect(tokenHash).toBeTruthy();

      const recovering = anonClient();
      const { data: verified, error: verifyError } = await recovering.auth.verifyOtp({
        type: "recovery",
        token_hash: tokenHash,
      });
      expect(verifyError).toBeNull();
      expect(verified.session).toBeTruthy();
      expect(verified.user!.id).toBe(signupUserId);

      const { error: updateError } = await recovering.auth.updateUser({ password: NEW_PASSWORD });
      expect(updateError).toBeNull();

      const { data: withNew, error: newError } = await anonClient().auth.signInWithPassword({
        email: SIGNUP_EMAIL,
        password: NEW_PASSWORD,
      });
      expect(newError).toBeNull();
      expect(withNew.session).toBeTruthy();

      const { data: withOld, error: oldError } = await anonClient().auth.signInWithPassword({
        email: SIGNUP_EMAIL,
        password: VALID_PASSWORD,
      });
      expect(withOld.session).toBeNull();
      expect(oldError!.code).toBe("invalid_credentials");
    });

    it("rejects a reused recovery hash", async () => {
      const { data: link } = await admin.auth.admin.generateLink({
        type: "recovery",
        email: SIGNUP_EMAIL,
      });
      const tokenHash = link.properties!.hashed_token;

      const first = await anonClient().auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
      expect(first.error).toBeNull();

      const second = await anonClient().auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
      expect(second.data.session).toBeNull();
      expect(second.error).toBeTruthy();
    });
  });

  // What the account page's password panel relies on. Needs
  // GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD and the
  // password-changed notification on the dev GoTrue, and migration 00061.
  describe("password change from a password session", () => {
    const CHANGE_LOCAL = `test-email-auth-change-${ts}`;
    const CHANGE_EMAIL = `${CHANGE_LOCAL}@webhooks-test.local`;
    const OLD_PASSWORD = "the-old-password";
    const NEW_PASSWORD = "the-new-password";
    let changeUserId: string;

    async function signIn(password: string) {
      const client = anonClient();
      const { data, error } = await client.auth.signInWithPassword({
        email: CHANGE_EMAIL,
        password,
      });
      return { client, session: data.session, error };
    }

    it("creates the account", async () => {
      const { data, error } = await admin.auth.admin.createUser({
        email: CHANGE_EMAIL,
        password: OLD_PASSWORD,
        email_confirm: true,
      });
      expect(error).toBeNull();
      changeUserId = data.user!.id;
      createdUserIds.push(changeUserId);
    });

    it("refuses a new password without the current one", async () => {
      const { client } = await signIn(OLD_PASSWORD);
      const { error } = await client.auth.updateUser({ password: NEW_PASSWORD });
      expect(error!.code).toBe("current_password_required");
    });

    it("refuses a wrong current password", async () => {
      const { client } = await signIn(OLD_PASSWORD);
      const { error } = await client.auth.updateUser({
        password: NEW_PASSWORD,
        current_password: "not-the-old-password",
      });
      expect(error!.code).toBe("current_password_invalid");
    });

    it("changes it with the current one and ends only the other sessions", async () => {
      const other = await signIn(OLD_PASSWORD);
      const changing = await signIn(OLD_PASSWORD);
      expect(other.session).toBeTruthy();

      const { error } = await changing.client.auth.updateUser({
        password: NEW_PASSWORD,
        current_password: OLD_PASSWORD,
      });
      expect(error).toBeNull();

      const kept = await changing.client.auth.getUser();
      expect(kept.error).toBeNull();
      // GoTrue answers session_not_found, which auth-js reports as a missing session.
      const ended = await anonClient().auth.getUser(other.session!.access_token);
      expect(isAuthSessionMissingError(ended.error)).toBe(true);

      expect((await signIn(NEW_PASSWORD)).error).toBeNull();
      expect((await signIn(OLD_PASSWORD)).error!.code).toBe("invalid_credentials");
    });

    it("records the change once in audit_events, and sign-ins not at all", async () => {
      // Five sign-ins and two refused changes above touched auth.users too.
      expect(await passwordAuditRows(changeUserId)).toEqual([
        { actor_type: "user", via: null, outcome: "ok", metadata: {} },
      ]);
    });

    it("emails the account from noreply@webhooks.cc", async () => {
      // Also matches GoTrue's default subject, which it falls back to when the
      // template host (the Next dev server) is down; this checks the sender.
      const message = await waitForMail(CHANGE_LOCAL, /password was changed/i);
      expect(message.from).toContain("<noreply@webhooks.cc>");
    });
  });

  describe("account created without a password (agent registration)", () => {
    it("sets one from an email-link session, recorded as an ordinary change", async () => {
      // admin.createUser without a password still gets one: GoTrue sets a
      // random password nobody knows. Such accounts sign in with email links,
      // whose sessions skip the current-password check.
      const email = `test-email-auth-nopw-${ts}@webhooks-test.local`;
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
      });
      expect(error).toBeNull();
      createdUserIds.push(created.user!.id);

      const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
      const client = anonClient();
      const { error: verifyError } = await client.auth.verifyOtp({
        type: "email",
        token_hash: link.properties!.hashed_token,
      });
      expect(verifyError).toBeNull();
      const { error: updateError } = await client.auth.updateUser({ password: "a-first-password" });
      expect(updateError).toBeNull();

      expect(await passwordAuditRows(created.user!.id)).toEqual([
        { actor_type: "user", via: null, outcome: "ok", metadata: {} },
      ]);
    });
  });
});

async function passwordAuditRows(userId: string) {
  const { data, error } = await admin
    .from("audit_events")
    .select("actor_type, via, outcome, metadata")
    .eq("actor_user_id", userId)
    .eq("action", "account.password_changed");
  if (error) throw error;
  return data;
}

/** Polls the dev Inbucket (mailbox = the address's local part) for a matching message. */
async function waitForMail(mailbox: string, subject: RegExp) {
  const base = process.env.INBUCKET_URL ?? "http://localhost:9000";
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${base}/api/v1/mailbox/${encodeURIComponent(mailbox)}`);
    const messages = res.ok ? ((await res.json()) as { from: string; subject: string }[]) : [];
    const match = messages.find((message) => subject.test(message.subject));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No message matching ${subject} in Inbucket mailbox ${mailbox}`);
}
