/**
 * Email/password auth against the dev Supabase instance.
 *
 * Environmental requirements beyond the usual env vars (like the
 * receiver-dependent suites): the dev GoTrue must carry the email-auth config
 * from infra/supabase/gotrue-email-auth.md (password min length 8, real SMTP)
 * and the `supabase-mail` Inbucket container must be up, because anon signUp
 * sends a confirmation email and fails at the SMTP hop without it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
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
});
