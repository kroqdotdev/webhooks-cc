import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

  // Every write to endpoints and api_keys goes through a server route with the
  // service role (migration 00045). A direct PostgREST write fails with 42501
  // instead of skipping the routes' validation, caps and audit trail.
  describe("no client writes on endpoints and api_keys", () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let userClient: SupabaseClient;
    let endpointId: string;
    let keyId: string;

    beforeAll(async () => {
      userClient = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: signInError } = await userClient.auth.signInWithPassword({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });
      expect(signInError).toBeNull();

      const { data: endpoint, error: endpointError } = await admin
        .from("endpoints")
        .insert({ user_id: testUserId, slug: `rls-writes-${suffix}`, name: "original" })
        .select("id")
        .single();
      expect(endpointError).toBeNull();
      endpointId = endpoint!.id;

      const { data: key, error: keyError } = await admin
        .from("api_keys")
        .insert({
          user_id: testUserId,
          name: "original",
          key_hash: `rls-writes-hash-${suffix}`,
          key_prefix: "whcc_rlswrit",
        })
        .select("id")
        .single();
      expect(keyError).toBeNull();
      keyId = key!.id;
    });

    afterAll(async () => {
      await admin.from("api_keys").delete().eq("key_hash", `rls-writes-hash-${suffix}`);
      await admin.from("api_keys").delete().eq("key_hash", `rls-writes-forged-${suffix}`);
      await admin.from("endpoints").delete().like("slug", `rls-writes-%${suffix}`);
    });

    // Inserts ask for no returned row: anon cannot read an unowned ephemeral
    // endpoint, so with RETURNING the insert would fail on the read even
    // while the insert itself is allowed.
    async function endpointExists(slug: string) {
      const { count } = await admin
        .from("endpoints")
        .select("id", { count: "exact", head: true })
        .eq("slug", slug);
      return count === 1;
    }

    it("anon cannot insert an unowned ephemeral endpoint", async () => {
      const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const slug = `rls-writes-anon-${suffix}`;
      const { error } = await anonClient.from("endpoints").insert({
        slug,
        is_ephemeral: true,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

      expect(error?.code).toBe("42501");
      expect(await endpointExists(slug)).toBe(false);
    });

    it("a signed-in user cannot insert an endpoint", async () => {
      const slug = `rls-writes-own-${suffix}`;
      const { error } = await userClient.from("endpoints").insert({ user_id: testUserId, slug });

      expect(error?.code).toBe("42501");
      expect(await endpointExists(slug)).toBe(false);
    });

    it("a signed-in user cannot update their own endpoint", async () => {
      const { error } = await userClient
        .from("endpoints")
        .update({ name: "changed", request_count: 1_000_000 })
        .eq("id", endpointId);

      expect(error?.code).toBe("42501");
      const { data: row } = await admin
        .from("endpoints")
        .select("name, request_count")
        .eq("id", endpointId)
        .single();
      expect(row).toEqual({ name: "original", request_count: 0 });
    });

    it("a signed-in user cannot delete their own endpoint", async () => {
      const { error } = await userClient.from("endpoints").delete().eq("id", endpointId);

      expect(error?.code).toBe("42501");
      const { count } = await admin
        .from("endpoints")
        .select("id", { count: "exact", head: true })
        .eq("id", endpointId);
      expect(count).toBe(1);
    });

    it("a signed-in user can still read their own endpoint and API key", async () => {
      const { data: endpoints, error: endpointsError } = await userClient
        .from("endpoints")
        .select("id")
        .eq("id", endpointId);
      expect(endpointsError).toBeNull();
      expect(endpoints).toEqual([{ id: endpointId }]);

      const { data: keys, error: keysError } = await userClient
        .from("api_keys")
        .select("id")
        .eq("id", keyId);
      expect(keysError).toBeNull();
      expect(keys).toEqual([{ id: keyId }]);
    });

    it("a signed-in user cannot insert an API key", async () => {
      const keyHash = `rls-writes-forged-${suffix}`;
      const { error } = await userClient.from("api_keys").insert({
        user_id: testUserId,
        name: "forged",
        key_hash: keyHash,
        key_prefix: "whcc_forged0",
      });

      expect(error?.code).toBe("42501");
      const { count } = await admin
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("key_hash", keyHash);
      expect(count).toBe(0);
    });

    it("a signed-in user cannot delete their own API key", async () => {
      const { error } = await userClient.from("api_keys").delete().eq("id", keyId);

      expect(error?.code).toBe("42501");
      const { count } = await admin
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("id", keyId);
      expect(count).toBe(1);
    });
  });
});
