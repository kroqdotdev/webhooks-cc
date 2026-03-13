import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";

const polarMocks = vi.hoisted(() => ({
  createPolarClient: vi.fn(),
  getPolarCheckoutConfig: vi.fn(),
  getPolarWebhookSecret: vi.fn(),
  validateEvent: vi.fn(),
}));

vi.mock("@/lib/polar", () => {
  class PolarConfigError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PolarConfigError";
    }
  }

  return {
    createPolarClient: polarMocks.createPolarClient,
    getPolarCheckoutConfig: polarMocks.getPolarCheckoutConfig,
    getPolarWebhookSecret: polarMocks.getPolarWebhookSecret,
    unwrapPolarResult: <T>(result: T) => result,
    PolarConfigError,
  };
});

vi.mock("@polar-sh/sdk/webhooks", () => {
  class WebhookVerificationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "WebhookVerificationError";
    }
  }

  return {
    validateEvent: polarMocks.validateEvent,
    WebhookVerificationError,
  };
});

import { DELETE as deleteAccountRoute } from "@/app/api/account/route";
import { POST as cancelBillingRoute } from "@/app/api/billing/cancel/route";
import { POST as checkoutBillingRoute } from "@/app/api/billing/checkout/route";
import { POST as resubscribeBillingRoute } from "@/app/api/billing/resubscribe/route";
import { POST as polarWebhookRoute } from "@/app/api/polar-webhook/route";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://192.168.0.247:8000";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const TEST_PASSWORD = "TestPassword123!";

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

if (!ANON_KEY) {
  throw new Error("SUPABASE_ANON_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function createAnonClient() {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function authRequest(path: string, accessToken: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return new Request(`https://webhooks.cc${path}`, {
    ...init,
    headers,
  });
}

async function updateUser(
  userId: string,
  patch: Database["public"]["Tables"]["users"]["Update"]
): Promise<void> {
  const { error } = await admin.from("users").update(patch).eq("id", userId);
  expect(error).toBeNull();
}

describe("Supabase Billing Integration", () => {
  let testUserId = "";
  let accessToken = "";

  beforeEach(async () => {
    polarMocks.createPolarClient.mockReset();
    polarMocks.getPolarCheckoutConfig.mockReset();
    polarMocks.getPolarWebhookSecret.mockReset();
    polarMocks.validateEvent.mockReset();

    polarMocks.getPolarCheckoutConfig.mockReturnValue({
      appUrl: "https://webhooks.cc",
      proProductId: "prod_test_123",
    });
    polarMocks.getPolarWebhookSecret.mockReturnValue("whsec_test_123");

    const email = `test-billing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@webhooks-test.local`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: "Billing Test User",
      },
    });

    expect(error).toBeNull();
    testUserId = data.user!.id;

    const anonClient = createAnonClient();
    const signIn = await anonClient.auth.signInWithPassword({
      email,
      password: TEST_PASSWORD,
    });

    expect(signIn.error).toBeNull();
    accessToken = signIn.data.session!.access_token;
  });

  afterEach(async () => {
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }

    testUserId = "";
    accessToken = "";
  });

  it("creates a Polar checkout session through the new billing route and stores the customer id", async () => {
    const customerCreate = vi.fn().mockResolvedValue({ id: "polar_cust_123" });
    const checkoutCreate = vi.fn().mockResolvedValue({
      url: "https://sandbox.polar.sh/checkout/test-session",
    });

    polarMocks.createPolarClient.mockReturnValue({
      customers: { create: customerCreate },
      checkouts: { create: checkoutCreate },
      subscriptions: { update: vi.fn() },
    });

    const response = await checkoutBillingRoute(
      authRequest("/api/billing/checkout", accessToken, { method: "POST" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://sandbox.polar.sh/checkout/test-session",
    });

    expect(customerCreate).toHaveBeenCalledWith({
      email: expect.stringContaining("@webhooks-test.local"),
      name: "Billing Test User",
      externalId: testUserId,
      metadata: {
        userId: testUserId,
      },
    });
    expect(checkoutCreate).toHaveBeenCalledWith({
      products: ["prod_test_123"],
      successUrl: "https://webhooks.cc/account?upgraded=true",
      customerId: "polar_cust_123",
    });

    const { data: userRow, error: userError } = await admin
      .from("users")
      .select("polar_customer_id")
      .eq("id", testUserId)
      .single();

    expect(userError).toBeNull();
    expect(userRow?.polar_customer_id).toBe("polar_cust_123");
  });

  it("cancels and reactivates a subscription through the new billing routes", async () => {
    await updateUser(testUserId, {
      plan: "pro",
      polar_customer_id: "polar_cust_123",
      polar_subscription_id: "polar_sub_123",
      subscription_status: "active",
      request_limit: 100_000,
      period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      cancel_at_period_end: false,
    });

    const subscriptionUpdate = vi.fn().mockResolvedValue({ id: "polar_sub_123" });
    polarMocks.createPolarClient.mockReturnValue({
      customers: { create: vi.fn() },
      checkouts: { create: vi.fn() },
      subscriptions: { update: subscriptionUpdate },
    });

    const cancelResponse = await cancelBillingRoute(
      authRequest("/api/billing/cancel", accessToken, { method: "POST" })
    );
    expect(cancelResponse.status).toBe(200);

    const { data: canceledUser, error: cancelError } = await admin
      .from("users")
      .select("cancel_at_period_end")
      .eq("id", testUserId)
      .single();

    expect(cancelError).toBeNull();
    expect(canceledUser?.cancel_at_period_end).toBe(true);

    const resubscribeResponse = await resubscribeBillingRoute(
      authRequest("/api/billing/resubscribe", accessToken, { method: "POST" })
    );
    expect(resubscribeResponse.status).toBe(200);

    const { data: reactivatedUser, error: reactivateError } = await admin
      .from("users")
      .select("cancel_at_period_end")
      .eq("id", testUserId)
      .single();

    expect(reactivateError).toBeNull();
    expect(reactivatedUser?.cancel_at_period_end).toBe(false);
    expect(subscriptionUpdate).toHaveBeenNthCalledWith(1, {
      id: "polar_sub_123",
      subscriptionUpdate: {
        cancelAtPeriodEnd: true,
      },
    });
    expect(subscriptionUpdate).toHaveBeenNthCalledWith(2, {
      id: "polar_sub_123",
      subscriptionUpdate: {
        cancelAtPeriodEnd: false,
      },
    });
  });

  it("applies Polar webhook events through the new webhook route for upgrade, cancel, and revoke flows", async () => {
    const periodStart = new Date();
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    polarMocks.validateEvent.mockReturnValueOnce({
      type: "subscription.created",
      data: {
        id: "polar_sub_webhook",
        customerId: "polar_cust_webhook",
        customer: {
          metadata: {
            userId: testUserId,
          },
        },
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      },
    });

    const createdResponse = await polarWebhookRoute(
      new Request("https://webhooks.cc/api/polar-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": "evt_123",
          "webhook-signature": "sig_123",
          "webhook-timestamp": `${Math.floor(Date.now() / 1000)}`,
        },
        body: JSON.stringify({}),
      })
    );

    expect(createdResponse.status).toBe(200);

    const { data: upgradedUser, error: upgradedError } = await admin
      .from("users")
      .select("plan, request_limit, polar_customer_id, polar_subscription_id, subscription_status")
      .eq("id", testUserId)
      .single();

    expect(upgradedError).toBeNull();
    expect(upgradedUser).toEqual({
      plan: "pro",
      request_limit: 100_000,
      polar_customer_id: "polar_cust_webhook",
      polar_subscription_id: "polar_sub_webhook",
      subscription_status: "active",
    });

    polarMocks.validateEvent.mockReturnValueOnce({
      type: "subscription.canceled",
      data: {
        customerId: "polar_cust_webhook",
      },
    });

    const canceledResponse = await polarWebhookRoute(
      new Request("https://webhooks.cc/api/polar-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": "evt_234",
          "webhook-signature": "sig_234",
          "webhook-timestamp": `${Math.floor(Date.now() / 1000)}`,
        },
        body: JSON.stringify({}),
      })
    );

    expect(canceledResponse.status).toBe(200);

    const { data: canceledUser, error: canceledError } = await admin
      .from("users")
      .select("plan, cancel_at_period_end, subscription_status")
      .eq("id", testUserId)
      .single();

    expect(canceledError).toBeNull();
    expect(canceledUser).toEqual({
      plan: "pro",
      cancel_at_period_end: true,
      subscription_status: "canceled",
    });

    polarMocks.validateEvent.mockReturnValueOnce({
      type: "subscription.revoked",
      data: {
        customerId: "polar_cust_webhook",
      },
    });

    const revokedResponse = await polarWebhookRoute(
      new Request("https://webhooks.cc/api/polar-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": "evt_456",
          "webhook-signature": "sig_456",
          "webhook-timestamp": `${Math.floor(Date.now() / 1000)}`,
        },
        body: JSON.stringify({}),
      })
    );

    expect(revokedResponse.status).toBe(200);

    const { data: downgradedUser, error: downgradedError } = await admin
      .from("users")
      .select("plan, request_limit, polar_subscription_id, subscription_status, cancel_at_period_end")
      .eq("id", testUserId)
      .single();

    expect(downgradedError).toBeNull();
    expect(downgradedUser).toEqual({
      plan: "free",
      request_limit: 50,
      polar_subscription_id: null,
      subscription_status: null,
      cancel_at_period_end: false,
    });
  });

  it("deletes the auth user plus request-bearing account data through the new account route", async () => {
    const { data: endpointRow, error: endpointError } = await admin
      .from("endpoints")
      .insert({
        user_id: testUserId,
        slug: `billing-delete-${Date.now()}`,
        name: "Delete Me",
      })
      .select("id")
      .single();

    expect(endpointError).toBeNull();
    expect(endpointRow).toBeTruthy();

    const { error: requestError } = await admin.from("requests").insert({
      endpoint_id: endpointRow!.id,
      user_id: testUserId,
      method: "POST",
      path: "/delete-me",
      headers: {},
      query_params: {},
      ip: "127.0.0.1",
      size: 10,
    });
    expect(requestError).toBeNull();

    const { error: apiKeyError } = await admin.from("api_keys").insert({
      user_id: testUserId,
      key_hash: `hash-${Date.now()}`,
      key_prefix: "whcc_test_12",
      name: "Delete Key",
    });
    expect(apiKeyError).toBeNull();

    const { error: deviceCodeError } = await admin.from("device_codes").insert({
      device_code: `device-${Date.now()}`,
      user_code: `ABCD-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      user_id: testUserId,
      status: "authorized",
    });
    expect(deviceCodeError).toBeNull();

    const response = await deleteAccountRoute(
      authRequest("/api/account", accessToken, { method: "DELETE" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });

    const { data: deletedAuthUser, error: deletedAuthError } = await admin.auth.admin.getUserById(
      testUserId
    );
    expect(deletedAuthError?.status).toBe(404);
    expect(deletedAuthUser.user).toBeNull();

    const { data: userRows } = await admin.from("users").select("id").eq("id", testUserId);
    expect(userRows).toEqual([]);

    const { data: requestRows } = await admin.from("requests").select("id").eq("user_id", testUserId);
    expect(requestRows).toEqual([]);

    const { data: endpointRows } = await admin
      .from("endpoints")
      .select("id")
      .eq("user_id", testUserId);
    expect(endpointRows).toEqual([]);

    const { data: apiKeyRows } = await admin.from("api_keys").select("id").eq("user_id", testUserId);
    expect(apiKeyRows).toEqual([]);

    const { data: deviceCodeRows } = await admin
      .from("device_codes")
      .select("id")
      .eq("user_id", testUserId);
    expect(deviceCodeRows).toEqual([]);

    testUserId = "";
    accessToken = "";
  });
});
