import { describe, it, expect, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}
if (!ANON_KEY) {
  throw new Error("SUPABASE_ANON_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_EMAIL = `test-auth-${Date.now()}@webhooks-test.local`;
const TEST_PASSWORD = "TestPassword123!";

let testUserId: string;

describe("Supabase Auth Integration", () => {
  afterAll(async () => {
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  describe("handle_new_user trigger", () => {
    it("creates a public.users row when a new auth user is created", async () => {
      const { data: authUser, error: createError } = await admin.auth.admin.createUser({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: {
          full_name: "Test User",
          avatar_url: "https://example.com/avatar.png",
        },
      });

      expect(createError).toBeNull();
      expect(authUser.user).toBeTruthy();
      testUserId = authUser.user!.id;

      // Verify the trigger created a public.users row
      const { data: profile, error: profileError } = await admin
        .from("users")
        .select("id, email, name, image, plan, requests_used, request_limit")
        .eq("id", testUserId)
        .single();

      expect(profileError).toBeNull();
      expect(profile).toBeTruthy();
      expect(profile!.email).toBe(TEST_EMAIL);
      expect(profile!.name).toBe("Test User");
      expect(profile!.image).toBe("https://example.com/avatar.png");
      expect(profile!.plan).toBe("free");
      expect(profile!.requests_used).toBe(0);
      expect(profile!.request_limit).toBe(50);
    });

    it("auth user id matches public.users.id", async () => {
      const { data: profile } = await admin
        .from("users")
        .select("id")
        .eq("id", testUserId)
        .single();

      expect(profile).toBeTruthy();
      expect(profile!.id).toBe(testUserId);
    });
  });

  describe("user authentication", () => {
    it("can sign in with email/password and get a session", async () => {
      const anonClient = createClient(SUPABASE_URL, ANON_KEY);

      const { data, error } = await anonClient.auth.signInWithPassword({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });

      expect(error).toBeNull();
      expect(data.session).toBeTruthy();
      expect(data.user).toBeTruthy();
      expect(data.user!.id).toBe(testUserId);
      expect(data.user!.email).toBe(TEST_EMAIL);
    });
  });

  describe("auth providers", () => {
    it("returns identities for the user", async () => {
      const { data: authUser } = await admin.auth.admin.getUserById(testUserId);
      expect(authUser.user).toBeTruthy();

      // For email-created users, the identity provider is "email"
      const identities = authUser.user!.identities ?? [];
      expect(identities.length).toBeGreaterThan(0);
      expect(identities[0].provider).toBeTruthy();
    });
  });

  describe("RLS enforcement on users table", () => {
    it("anon client cannot read other users data", async () => {
      const anonClient = createClient(SUPABASE_URL, ANON_KEY);

      // Without auth, anon should not see any users (RLS: auth.uid() = id)
      const { data, error } = await anonClient.from("users").select("id").limit(10);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("authenticated user can only see their own row", async () => {
      const anonClient = createClient(SUPABASE_URL, ANON_KEY);

      const { data: signInData } = await anonClient.auth.signInWithPassword({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });

      expect(signInData.session).toBeTruthy();

      // Authenticated user should see exactly 1 row (their own)
      const { data: users, error } = await anonClient.from("users").select("id, email");

      expect(error).toBeNull();
      expect(users).toHaveLength(1);
      expect(users![0].id).toBe(testUserId);
      expect(users![0].email).toBe(TEST_EMAIL);
    });
  });
});
