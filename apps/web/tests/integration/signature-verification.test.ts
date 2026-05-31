import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { buildTemplateSendOptions } from "@webhooks-cc/sdk";
import type { Database } from "@/lib/supabase/database";
import {
  createEndpointForUser,
  getEndpointBySlugForUser,
  updateEndpointBySlugForUser,
} from "@/lib/supabase/endpoints";
import { getRequestByIdForUser, listRequestsForEndpointByUser } from "@/lib/supabase/requests";

const RECEIVER_URL = process.env.WHK_RECEIVER_URL ?? "http://localhost:3001";

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
    expect(
      (endpoint as unknown as Record<string, unknown>).signing_secret_encrypted
    ).toBeUndefined();
  });

  it("PATCH: keeps the existing secret when the provider is unchanged", async () => {
    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: testEndpointSlug,
      signingProvider: "stripe",
    });

    expect(updated!.signingProvider).toBe("stripe");
    // Secret should still be present from previous config
    expect(updated!.hasSigningSecret).toBe(true);
  });

  it("PATCH: rejects provider changes without a fresh secret", async () => {
    await expect(
      updateEndpointBySlugForUser({
        userId: testUserId,
        slug: testEndpointSlug,
        signingProvider: "github",
      })
    ).rejects.toThrow(/Signing secret is required/);

    const endpoint = await getEndpointBySlugForUser(testUserId, testEndpointSlug);
    expect(endpoint!.signingProvider).toBe("stripe");
    expect(endpoint!.hasSigningSecret).toBe(true);
  });

  it("PATCH: rejects providers that do not support receiver verification", async () => {
    await expect(
      updateEndpointBySlugForUser({
        userId: testUserId,
        slug: testEndpointSlug,
        signingProvider: "sendgrid",
        signingSecret: "sendgrid_has_no_signing_secret",
      })
    ).rejects.toThrow(/Invalid signing provider/);

    const endpoint = await getEndpointBySlugForUser(testUserId, testEndpointSlug);
    expect(endpoint!.signingProvider).toBe("stripe");
    expect(endpoint!.hasSigningSecret).toBe(true);
  });

  it("PATCH: accepts every tier-1 signing provider", async () => {
    const tier1 = [
      "meta",
      "lemonsqueezy",
      "coinbase-commerce",
      "razorpay",
      "cal",
      "intercom",
      "telegram",
    ];

    for (const provider of tier1) {
      const updated = await updateEndpointBySlugForUser({
        userId: testUserId,
        slug: testEndpointSlug,
        signingProvider: provider,
        signingSecret: `secret_for_${provider}`,
      });

      expect(updated).not.toBeNull();
      expect(updated!.signingProvider).toBe(provider);
      expect(updated!.hasSigningSecret).toBe(true);
    }
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

  it("PATCH: rejects generic-hmac without a signing header", async () => {
    await expect(
      updateEndpointBySlugForUser({
        userId: testUserId,
        slug: testEndpointSlug,
        signingProvider: "generic-hmac",
        signingSecret: "my_custom_secret",
      })
    ).rejects.toThrow(/Generic HMAC requires a signing header/);
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

  it("PATCH: clears stale generic header when switching back to a named provider", async () => {
    const updated = await updateEndpointBySlugForUser({
      userId: testUserId,
      slug: testEndpointSlug,
      signingProvider: "stripe",
      signingSecret: "whsec_reconfigured_secret",
    });

    expect(updated!.signingProvider).toBe("stripe");
    expect(updated!.hasSigningSecret).toBe(true);
    expect(updated!.signingHeader).toBeNull();
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
        body: "{}",
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
    const requests = await listRequestsForEndpointByUser({
      userId: testUserId,
      slug: testEndpointSlug,
    });
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

  it("PATCH: accepts every tier-2 signing provider", async () => {
    const tier2 = ["square", "hubspot", "mailgun", "calendly", "mux", "sentry", "bitbucket"];

    for (const provider of tier2) {
      const updated = await updateEndpointBySlugForUser({
        userId: testUserId,
        slug: testEndpointSlug,
        signingProvider: provider,
        signingSecret: `secret_for_${provider}`,
      });

      expect(updated, `provider ${provider} should be accepted`).not.toBeNull();
      expect(updated!.signingProvider).toBe(provider);
      expect(updated!.hasSigningSecret).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// End-to-end automatic verification through the Rust receiver (tier-2).
//
// For each tier-2 provider we configure the endpoint's signing provider+secret,
// build a fully-signed template request with the SDK (signed against the exact
// receiver capture URL so the request-context providers — Square (URL+body) and
// HubSpot (method+URI+body+timestamp) — line up), POST it to the receiver, then
// poll the captured request until the receiver's async verification has run and
// assert signature_verified === true with the correct signing_provider.
//
// Requires the Rust receiver (port 3001) to be running with the same
// SIGNING_SECRET_KEY the web app uses to encrypt the stored secret. If the
// receiver is not reachable the whole block is skipped.
// ───────────────────────────────────────────────────────────────────────────

type Tier2Case = {
  provider: string;
  secret: string;
  /** Provider needs the request URL/method threaded by the receiver. */
  requestContext?: "url" | "url+method";
  /** Provider has no signature header — signature lives in the body. */
  bodyEmbedded?: boolean;
};

const TIER2_CASES: Tier2Case[] = [
  { provider: "square", secret: "sq_signature_key", requestContext: "url" },
  { provider: "hubspot", secret: "hs_app_client_secret", requestContext: "url+method" },
  { provider: "mailgun", secret: "mg_signing_key", bodyEmbedded: true },
  { provider: "calendly", secret: "cal_signing_key" },
  { provider: "mux", secret: "mux_signing_secret" },
  { provider: "sentry", secret: "sentry_client_secret" },
  { provider: "bitbucket", secret: "bitbucket_webhook_secret" },
];

async function receiverReachable(): Promise<boolean> {
  try {
    const resp = await fetch(`${RECEIVER_URL}/w/__healthcheck-nonexistent__/`, {
      method: "GET",
    });
    // 404 (unknown slug) still proves the receiver is answering on this port.
    return resp.status === 404 || resp.status === 200;
  } catch {
    return false;
  }
}

/** Poll the captured request until the async verification result is written. */
async function pollForVerification(
  userId: string,
  slug: string,
  path: string,
  timeoutMs = 8000
): Promise<{ signatureVerified: boolean | null; signingProvider: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requests = await listRequestsForEndpointByUser({ userId, slug, limit: 25 });
    const match = requests?.find((r) => r.path === path);
    if (match && match.signatureVerified !== null && match.signatureVerified !== undefined) {
      return {
        signatureVerified: match.signatureVerified,
        signingProvider: match.signingProvider ?? null,
      };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

describe("Tier-2 automatic verification through the receiver", () => {
  const SUITE_EMAIL = `test-tier2-recv-${Date.now()}@webhooks-test.local`;
  let userId: string;
  let endpointId: string;
  let slug: string;
  let skipSuite = false;

  beforeAll(async () => {
    if (!(await receiverReachable())) {
      skipSuite = true;
      return;
    }

    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email: SUITE_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (authError) throw authError;
    userId = authData.user.id;

    await admin
      .from("users")
      .update({
        plan: "pro",
        request_limit: 10000,
        requests_used: 0,
        period_end: new Date(Date.now() + 86400000).toISOString(),
      })
      .eq("id", userId);

    const endpoint = await createEndpointForUser({ userId, name: "Tier-2 Receiver Verify" });
    endpointId = endpoint.id;
    slug = endpoint.slug;
  }, 20000);

  afterAll(async () => {
    if (endpointId) {
      await admin.from("requests").delete().eq("endpoint_id", endpointId);
      await admin.from("endpoints").delete().eq("id", endpointId);
    }
    if (userId) {
      await admin.auth.admin.deleteUser(userId);
    }
  }, 20000);

  for (const tc of TIER2_CASES) {
    it(`verifies a valid ${tc.provider} webhook end-to-end (signature_verified === true)`, async () => {
      if (skipSuite) {
        // Receiver not running — covered by the Verify gate which starts it.
        return;
      }

      // Configure the endpoint's signing provider + secret (encrypted at rest).
      await updateEndpointBySlugForUser({
        userId,
        slug,
        signingProvider: tc.provider,
        signingSecret: tc.secret,
      });

      // The receiver verifies against `${RECEIVER_URL}/w/${slug}` (root path "/").
      // Sign the template against that exact URL so URL/method-bound providers match.
      const captureUrl = `${RECEIVER_URL}/w/${slug}`;
      const signed = await buildTemplateSendOptions(captureUrl, {
        provider: tc.provider as Parameters<typeof buildTemplateSendOptions>[1]["provider"],
        secret: tc.secret,
        method: "POST",
      });

      const resp = await fetch(captureUrl, {
        method: signed.method ?? "POST",
        headers: signed.headers as Record<string, string>,
        body: signed.body as string,
      });
      expect(resp.status).toBe(200);

      const result = await pollForVerification(userId, slug, "/");
      expect(result, `no verification result written for ${tc.provider}`).not.toBeNull();
      expect(result!.signatureVerified, `${tc.provider} should verify`).toBe(true);
      expect(result!.signingProvider).toBe(tc.provider);
    }, 15000);
  }

  // Representative tampered-body false cases across the scheme families:
  // body-bound hex (sentry), URL+body (square), and body-embedded (mailgun).
  for (const tc of TIER2_CASES.filter((c) =>
    ["sentry", "square", "mailgun"].includes(c.provider)
  )) {
    it(`rejects a tampered ${tc.provider} body (signature_verified === false)`, async () => {
      if (skipSuite) return;

      await updateEndpointBySlugForUser({
        userId,
        slug,
        signingProvider: tc.provider,
        signingSecret: tc.secret,
      });

      const captureUrl = `${RECEIVER_URL}/w/${slug}`;
      const signed = await buildTemplateSendOptions(captureUrl, {
        provider: tc.provider as Parameters<typeof buildTemplateSendOptions>[1]["provider"],
        secret: tc.secret,
        method: "POST",
      });

      // Tamper with the body after signing — the signature no longer matches.
      // For the body-embedded scheme (Mailgun) we must corrupt the embedded
      // signature field, since whitespace outside the JSON does not change the
      // signed `timestamp + token`. For body-bound/URL-bound schemes a trailing
      // byte is enough to break the HMAC over the raw body.
      let tamperedBody: string;
      if (tc.bodyEmbedded) {
        const parsed = JSON.parse(signed.body as string) as {
          signature?: { signature?: string };
          [key: string]: unknown;
        };
        parsed.signature = {
          ...parsed.signature,
          signature: "0".repeat((parsed.signature?.signature ?? "deadbeef").length),
        };
        tamperedBody = JSON.stringify(parsed);
      } else {
        tamperedBody = `${signed.body as string} `;
      }
      const tamperPath = `/tamper-${tc.provider}-${Date.now()}`;
      const resp = await fetch(`${captureUrl}${tamperPath}`, {
        method: "POST",
        headers: signed.headers as Record<string, string>,
        body: tamperedBody,
      });
      expect(resp.status).toBe(200);

      const result = await pollForVerification(userId, slug, tamperPath);
      expect(result, `no verification result written for tampered ${tc.provider}`).not.toBeNull();
      // For URL-bound providers the path change ALSO breaks the signature, which
      // is still a correct "tampered → not verified" outcome.
      expect(result!.signatureVerified, `tampered ${tc.provider} must not verify`).toBe(false);
      expect(result!.signingProvider).toBe(tc.provider);
    }, 15000);
  }
});
