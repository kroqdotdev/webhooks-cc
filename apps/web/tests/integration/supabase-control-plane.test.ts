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

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
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
      mockResponse: {
        status: 201,
        body: "created",
        headers: { "x-created": "true" },
      },
    });

    expect(created.id).toBeTruthy();
    expect(created.slug).toMatch(/^[a-z0-9]{10}$/);
    expect(created.name).toBe("Control Plane Endpoint");
    expect(created.isEphemeral).toBe(true);
    expect(created.expiresAt).toBeGreaterThan(Date.now());
    expect(created.url).toContain(`/w/${created.slug}`);

    const { data: createdEndpointRow, error: createdEndpointError } = await admin
      .from("endpoints")
      .select("mock_response")
      .eq("id", created.id)
      .single();

    expect(createdEndpointError).toBeNull();
    expect(createdEndpointRow?.mock_response).toEqual({
      status: 201,
      body: "created",
      headers: { "x-created": "true" },
    });

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

    const { error: requestInsertError } = await admin.from("requests").insert({
      endpoint_id: created.id,
      user_id: testUserId,
      method: "POST",
      path: "/cleanup-me",
      headers: {},
      query_params: {},
      ip: "127.0.0.1",
      size: 0,
      received_at: new Date().toISOString(),
    });

    expect(requestInsertError).toBeNull();

    const deleted = await deleteEndpointBySlugForUser(testUserId, created.slug);
    expect(deleted).toBe(true);

    const missing = await getEndpointBySlugForUser(testUserId, created.slug);
    expect(missing).toBeNull();

    const { data: orphanedRequests, error: orphanedError } = await admin
      .from("requests")
      .select("id")
      .eq("endpoint_id", created.id);

    expect(orphanedError).toBeNull();
    expect(orphanedRequests).toEqual([]);
  });

  it("creates endpoints with notificationUrl and round-trips it", async () => {
    const created = await createEndpointForUser({
      userId: testUserId,
      name: "Notification Test",
      notificationUrl: "https://hooks.slack.com/services/T00/B00/xxx",
    });

    expect(created.notificationUrl).toBe("https://hooks.slack.com/services/T00/B00/xxx");

    // Verify it's persisted in the database
    const { data: row, error } = await admin
      .from("endpoints")
      .select("notification_url")
      .eq("id", created.id)
      .single();

    expect(error).toBeNull();
    expect(row?.notification_url).toBe("https://hooks.slack.com/services/T00/B00/xxx");

    // Fetch via helper — should round-trip
    const fetched = await getEndpointBySlugForUser(testUserId, created.slug);
    expect(fetched?.notificationUrl).toBe("https://hooks.slack.com/services/T00/B00/xxx");

    // Update notification URL
    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: created.slug,
      notificationUrl: "https://discord.com/api/webhooks/123/abc",
    });

    expect(updated?.notificationUrl).toBe("https://discord.com/api/webhooks/123/abc");

    // Clear notification URL by setting to null
    const cleared = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: created.slug,
      notificationUrl: null,
    });

    expect(cleared?.notificationUrl).toBeNull();

    // Verify DB is null
    const { data: clearedRow } = await admin
      .from("endpoints")
      .select("notification_url")
      .eq("id", created.id)
      .single();

    expect(clearedRow?.notification_url).toBeNull();

    // Cleanup
    await deleteEndpointBySlugForUser(testUserId, created.slug);
  });

  it("creates endpoint without notificationUrl — defaults to null", async () => {
    const created = await createEndpointForUser({
      userId: testUserId,
      name: "No Notification",
    });

    expect(created.notificationUrl).toBeNull();

    // Cleanup
    await deleteEndpointBySlugForUser(testUserId, created.slug);
  });

  it("preserves notificationUrl when updating only name", async () => {
    const created = await createEndpointForUser({
      userId: testUserId,
      name: "Preserve Test",
      notificationUrl: "https://hooks.slack.com/services/T00/B00/keep",
    });

    // Update only name, don't send notificationUrl
    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: created.slug,
      name: "Renamed",
    });

    expect(updated?.name).toBe("Renamed");
    expect(updated?.notificationUrl).toBe("https://hooks.slack.com/services/T00/B00/keep");

    // Cleanup
    await deleteEndpointBySlugForUser(testUserId, created.slug);
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
