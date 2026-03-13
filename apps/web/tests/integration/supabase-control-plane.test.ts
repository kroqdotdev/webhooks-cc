import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { hashApiKey, validateApiKeyWithMetadata } from "@/lib/supabase/api-keys";
import {
  createEndpointForUser,
  deleteEndpointBySlugForUser,
  getEndpointBySlugForUser,
  listEndpointsForUser,
  updateEndpointBySlugForUser,
} from "@/lib/supabase/endpoints";
import { getUsageForUser } from "@/lib/supabase/usage";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://192.168.0.247:8000";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_EMAIL = `test-control-plane-${Date.now()}@webhooks-test.local`;
const TEST_PASSWORD = "TestPassword123!";
const TEST_API_KEY = `whcc_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let testUserId: string;

describe("Supabase Control Plane Integration", () => {
  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: "Control Plane Test User",
      },
    });

    if (error) {
      throw error;
    }

    testUserId = data.user!.id;
  });

  afterAll(async () => {
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  it("validates API keys against Supabase and records last use", async () => {
    const { error: insertError } = await admin.from("api_keys").insert({
      user_id: testUserId,
      key_hash: hashApiKey(TEST_API_KEY),
      key_prefix: TEST_API_KEY.slice(0, 12),
      name: "CLI test key",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(insertError).toBeNull();

    const validation = await validateApiKeyWithMetadata(TEST_API_KEY);
    expect(validation).toEqual({
      userId: testUserId,
      plan: "free",
    });

    const { data: keyRow, error: keyError } = await admin
      .from("api_keys")
      .select("last_used_at")
      .eq("key_hash", hashApiKey(TEST_API_KEY))
      .single();

    expect(keyError).toBeNull();
    expect(keyRow?.last_used_at).toBeTruthy();
  });

  it("creates, reads, updates, lists, and deletes endpoints for a user", async () => {
    const created = await createEndpointForUser({
      userId: testUserId,
      name: "Control Plane Endpoint",
      isEphemeral: true,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    expect(created.id).toBeTruthy();
    expect(created.slug).toHaveLength(8);
    expect(created.name).toBe("Control Plane Endpoint");
    expect(created.isEphemeral).toBe(true);
    expect(created.expiresAt).toBeGreaterThan(Date.now());
    expect(created.url).toContain(`/w/${created.slug}`);

    const fetched = await getEndpointBySlugForUser(testUserId, created.slug);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.slug).toBe(created.slug);

    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: created.slug,
      name: "Renamed Endpoint",
      mockResponse: {
        status: 202,
        body: "queued",
        headers: { "x-mock": "true" },
      },
    });

    expect(updated?.name).toBe("Renamed Endpoint");

    const { data: storedEndpoint, error: storedError } = await admin
      .from("endpoints")
      .select("mock_response")
      .eq("id", created.id)
      .single();

    expect(storedError).toBeNull();
    expect(storedEndpoint?.mock_response).toEqual({
      status: 202,
      body: "queued",
      headers: { "x-mock": "true" },
    });

    const listed = await listEndpointsForUser(testUserId);
    expect(listed.some((endpoint) => endpoint.id === created.id)).toBe(true);

    const deleted = await deleteEndpointBySlugForUser(testUserId, created.slug);
    expect(deleted).toBe(true);

    const missing = await getEndpointBySlugForUser(testUserId, created.slug);
    expect(missing).toBeNull();
  });

  it("returns usage in the SDK/CLI response shape", async () => {
    const { error: updateError } = await admin
      .from("users")
      .update({
        requests_used: 12,
        request_limit: 50,
        period_end: new Date(Date.now() + 60_000).toISOString(),
      })
      .eq("id", testUserId);

    expect(updateError).toBeNull();

    const usage = await getUsageForUser(testUserId);
    expect(usage).toEqual({
      used: 12,
      limit: 50,
      remaining: 38,
      plan: "free",
      periodEnd: expect.any(Number),
    });
  });
});
