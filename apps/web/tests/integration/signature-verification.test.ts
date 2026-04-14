import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import {
  createEndpointForUser,
  getEndpointBySlugForUser,
  updateEndpointBySlugForUser,
} from "@/lib/supabase/endpoints";
import {
  getRequestByIdForUser,
  listRequestsForEndpointByUser,
} from "@/lib/supabase/requests";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_EMAIL = `test-sigverify-${Date.now()}@webhooks-test.local`;
const TEST_PASSWORD = "TestPassword123!";

let testUserId: string;
let testEndpointId: string;
let testEndpointSlug: string;

describe("Signature Verification Integration", () => {
  beforeAll(async () => {
    // Create test user
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (authError) throw authError;
    testUserId = authData.user.id;

    // Give them pro plan
    await admin
      .from("users")
      .update({
        plan: "pro",
        request_limit: 10000,
        requests_used: 0,
        period_end: new Date(Date.now() + 86400000).toISOString(),
      })
      .eq("id", testUserId);

    // Create test endpoint
    const endpoint = await createEndpointForUser({
      userId: testUserId,
      name: "Sig Verify Integration",
    });
    testEndpointId = endpoint.id;
    testEndpointSlug = endpoint.slug;
  });

  afterAll(async () => {
    if (testEndpointId) {
      await admin.from("requests").delete().eq("endpoint_id", testEndpointId);
      await admin.from("endpoints").delete().eq("id", testEndpointId);
    }
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  // ── PATCH signing config ──

  it("PATCH: configure signing provider and secret", async () => {
    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: testEndpointSlug,
      signingProvider: "stripe",
      signingSecret: "whsec_test_secret_123",
    });

    expect(updated).not.toBeNull();
    expect(updated!.signingProvider).toBe("stripe");
    expect(updated!.hasSigningSecret).toBe(true);
  });

  it("GET: returns signingProvider and hasSigningSecret, never the secret", async () => {
    const endpoint = await getEndpointBySlugForUser(testUserId, testEndpointSlug);

    expect(endpoint).not.toBeNull();
    expect(endpoint!.signingProvider).toBe("stripe");
    expect(endpoint!.hasSigningSecret).toBe(true);
    // Secret must never be exposed
    expect((endpoint as unknown as Record<string, unknown>).signingSecret).toBeUndefined();
    expect((endpoint as unknown as Record<string, unknown>).signingSecretEncrypted).toBeUndefined();
    expect((endpoint as unknown as Record<string, unknown>).signing_secret_encrypted).toBeUndefined();
  });

  it("PATCH: update provider without re-entering secret", async () => {
    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: testEndpointSlug,
      signingProvider: "github",
    });

    expect(updated!.signingProvider).toBe("github");
    // Secret should still be present from previous config
    expect(updated!.hasSigningSecret).toBe(true);
  });

  it("PATCH: clear signing config with null provider", async () => {
    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: testEndpointSlug,
      signingProvider: null,
    });

    expect(updated!.signingProvider).toBeNull();
    expect(updated!.hasSigningSecret).toBe(false);
    expect(updated!.signingHeader).toBeNull();
  });

  it("PATCH: configure generic-hmac with signing header", async () => {
    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: testEndpointSlug,
      signingProvider: "generic-hmac",
      signingSecret: "my_custom_secret",
      signingHeader: "x-my-signature",
    });

    expect(updated!.signingProvider).toBe("generic-hmac");
    expect(updated!.hasSigningSecret).toBe(true);
    expect(updated!.signingHeader).toBe("x-my-signature");
  });

  // ── Request verification fields ──

  it("requests include verification fields", async () => {
    // Clear signing first so new requests have null verification
    await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: testEndpointSlug,
      signingProvider: null,
    });

    // Insert a request directly
    const { data: reqData, error: reqError } = await admin
      .from("requests")
      .insert({
        endpoint_id: testEndpointId,
        user_id: testUserId,
        method: "POST",
        path: "/test-sig",
        headers: { "content-type": "application/json" },
        body: '{"test":true}',
        query_params: {},
        content_type: "application/json",
        ip: "127.0.0.1",
        size: 13,
        received_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (reqError) throw reqError;

    const request = await getRequestByIdForUser(testUserId, reqData.id);
    expect(request).not.toBeNull();
    // No signing configured, so verification fields should be null
    expect(request!.signatureVerified).toBeNull();
    expect(request!.signatureError).toBeNull();
    expect(request!.signingProvider).toBeNull();
  });

  it("requests with verification results include them", async () => {
    // Insert a request with verification result directly
    const { data: reqData, error: reqError } = await admin
      .from("requests")
      .insert({
        endpoint_id: testEndpointId,
        user_id: testUserId,
        method: "POST",
        path: "/test-verified",
        headers: { "stripe-signature": "t=123,v1=abc" },
        body: '{"type":"invoice.paid"}',
        query_params: {},
        content_type: "application/json",
        ip: "127.0.0.1",
        size: 22,
        received_at: new Date().toISOString(),
        signature_verified: true,
        signing_provider: "stripe",
        signature_error: null,
      })
      .select("id")
      .single();
    if (reqError) throw reqError;

    const request = await getRequestByIdForUser(testUserId, reqData.id);
    expect(request!.signatureVerified).toBe(true);
    expect(request!.signingProvider).toBe("stripe");
    expect(request!.signatureError).toBeNull();
  });

  it("requests with failed verification include error", async () => {
    const errorJson = JSON.stringify({
      code: "mismatch",
      expected: "abc123",
      received: "xyz789",
    });

    const { data: reqData, error: reqError } = await admin
      .from("requests")
      .insert({
        endpoint_id: testEndpointId,
        user_id: testUserId,
        method: "POST",
        path: "/test-failed",
        headers: { "stripe-signature": "t=123,v1=wrong" },
        body: '{}',
        query_params: {},
        content_type: "application/json",
        ip: "127.0.0.1",
        size: 2,
        received_at: new Date().toISOString(),
        signature_verified: false,
        signing_provider: "stripe",
        signature_error: errorJson,
      })
      .select("id")
      .single();
    if (reqError) throw reqError;

    const request = await getRequestByIdForUser(testUserId, reqData.id);
    expect(request!.signatureVerified).toBe(false);
    expect(request!.signingProvider).toBe("stripe");
    expect(request!.signatureError).toBeTruthy();

    const err = JSON.parse(request!.signatureError!);
    expect(err.code).toBe("mismatch");
    expect(err.expected).toBe("abc123");
  });

  it("list requests includes verification fields", async () => {
    const requests = await listRequestsForEndpointByUser({ userId: testUserId, slug: testEndpointSlug });
    expect(requests).not.toBeNull();
    expect(requests!.length).toBeGreaterThan(0);

    // At least one request should have verification data
    const verified = requests!.find((r) => r.signatureVerified === true);
    expect(verified).toBeTruthy();
    expect(verified!.signingProvider).toBe("stripe");
  });

  // ── Encryption verification ──

  it("signing secret is stored encrypted (not plaintext)", async () => {
    // Configure a known secret
    await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: testEndpointSlug,
      signingProvider: "stripe",
      signingSecret: "whsec_plaintext_secret_value",
    });

    // Read the raw encrypted column directly
    const { data, error } = await admin
      .from("endpoints")
      .select("signing_secret_encrypted")
      .eq("slug", testEndpointSlug)
      .single();
    if (error) throw error;

    // The stored value should exist but not contain the plaintext
    expect(data.signing_secret_encrypted).toBeTruthy();
    expect(data.signing_secret_encrypted).not.toContain("plaintext_secret_value");
  });
});
