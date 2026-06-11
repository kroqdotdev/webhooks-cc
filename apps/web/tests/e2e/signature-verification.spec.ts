import { test, expect } from "@playwright/test";
import { createHmac } from "crypto";
import { buildTemplateSendOptions } from "@webhooks-cc/sdk";
import { encryptSigningSecret } from "@/lib/crypto";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

// Tests must run serially — they share an endpoint
test.describe.configure({ mode: "serial" });

let testUser: TestUser;
let endpointSlug: string;
let endpointId: string;

const WEBHOOK_URL = process.env.WHK_WEBHOOK_URL ?? "http://localhost:3001";
// The receiver reconstructs the URL it signs against from its own
// webhook_base_url (NEXT_PUBLIC_WEBHOOK_URL / WEBHOOK_BASE_URL), which may differ
// from the port we POST to (the Playwright-managed receiver listens on 3101 but
// loads base http://localhost:3001 from .env.local). URL-bound providers (Square,
// HubSpot) must be signed against the receiver's base, not the listen port.
const RECEIVER_BASE_URL = process.env.NEXT_PUBLIC_WEBHOOK_URL ?? WEBHOOK_URL;
const TEST_SECRET = "whsec_gK8z2xRvPqN7mT4jL9wYcE5bA1dF6hU3";

test.beforeAll(async () => {
  testUser = await createTestUser();

  await admin
    .from("users")
    .update({
      plan: "pro",
      request_limit: 10000,
      requests_used: 0,
      period_end: new Date(Date.now() + 86400000).toISOString(),
    })
    .eq("id", testUser.id);

  const { data, error } = await admin
    .from("endpoints")
    .insert({
      slug: `e2e-sig-${Date.now()}`,
      name: "Sig Verify E2E",
      user_id: testUser.id,
    })
    .select("id, slug")
    .single();
  if (error) throw error;
  endpointSlug = data.slug;
  endpointId = data.id;
});

test.afterAll(async () => {
  if (endpointId) {
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  if (testUser) {
    await deleteTestUser(testUser.id);
  }
});

async function openDashboard(page: import("@playwright/test").Page) {
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.locator("span.font-bold.uppercase", { hasText: "Sig Verify E2E" })).toBeVisible(
    { timeout: 10000 }
  );
}

async function openSettings(page: import("@playwright/test").Page) {
  await page.click('button[aria-label="Endpoint settings"]');
  await expect(page.locator("text=Endpoint Settings")).toBeVisible({ timeout: 5000 });
}

function sendSignedWebhook(slug: string, valid: boolean) {
  const msgId = `msg_e2e_${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ type: "test.e2e", valid });

  let sig: string;
  if (valid) {
    const rawSecret = Buffer.from(TEST_SECRET.replace("whsec_", ""), "base64");
    const payload = `${msgId}.${timestamp}.${body}`;
    sig = createHmac("sha256", rawSecret).update(payload).digest("base64");
  } else {
    sig = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  }

  return fetch(`${WEBHOOK_URL}/w/${slug}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": msgId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${sig}`,
    },
    body,
  });
}

async function insertServerVerifiedRequest({
  path,
  verified,
}: {
  path: string;
  verified: boolean;
}) {
  const body = JSON.stringify({ type: "test.e2e", path, verified });
  const signatureError = verified
    ? null
    : JSON.stringify({
        code: "mismatch",
        message: "Signature mismatch",
        expected: "expected-signature",
        received: "received-signature",
      });

  const { error } = await admin.from("requests").insert({
    endpoint_id: endpointId,
    user_id: testUser.id,
    method: "POST",
    path,
    headers: {
      "content-type": "application/json",
      "webhook-id": `msg_e2e_${Date.now()}`,
      "webhook-timestamp": Math.floor(Date.now() / 1000).toString(),
      "webhook-signature": "v1,e2e",
    },
    body,
    query_params: {},
    content_type: "application/json",
    ip: "127.0.0.1",
    size: Buffer.byteLength(body),
    signature_verified: verified,
    signature_error: signatureError,
    signing_provider: "standard-webhooks",
    received_at: new Date().toISOString(),
  });

  if (error) throw error;
}

function signatureTabButton(page: import("@playwright/test").Page) {
  return page.getByRole("button", { name: /^signature$/i }).first();
}

/**
 * Configure the endpoint's server-side signing provider + secret. The secret is
 * encrypted with the same SIGNING_SECRET_KEY the Playwright-managed receiver uses
 * (set in playwright.config.ts), so the receiver can decrypt and verify it.
 */
async function configureServerSigning(provider: string, secret: string) {
  const encrypted = encryptSigningSecret(secret);
  const { error } = await admin
    .from("endpoints")
    .update({
      signing_provider: provider,
      signing_secret_encrypted: `\\x${encrypted.toString("hex")}`,
      signing_header: null,
    })
    .eq("id", endpointId);
  if (error) throw error;
}

/**
 * Build a fully-signed tier-2 webhook with the SDK and POST it to the receiver.
 * Signs against the exact capture URL so URL/method-bound providers (Square,
 * HubSpot) line up with what the receiver reconstructs.
 */
async function sendTier2Webhook(provider: string, secret: string) {
  // Sign against the URL the RECEIVER reconstructs (its base + /w/{slug}),
  // but POST to the port the receiver actually listens on.
  const signingUrl = `${RECEIVER_BASE_URL}/w/${endpointSlug}`;
  const postUrl = `${WEBHOOK_URL}/w/${endpointSlug}`;
  const signed = await buildTemplateSendOptions(signingUrl, {
    provider: provider as Parameters<typeof buildTemplateSendOptions>[1]["provider"],
    secret,
    method: "POST",
  });
  const resp = await fetch(postUrl, {
    method: signed.method ?? "POST",
    headers: signed.headers as Record<string, string>,
    body: signed.body as string,
  });
  if (resp.status !== 200) {
    throw new Error(`receiver returned ${resp.status} for ${provider}`);
  }
}

/**
 * Build a fully-signed tier-2 webhook with the SDK and POST it to a marker path.
 * Signs against the URL the manual-verify UI reconstructs from
 * NEXT_PUBLIC_WEBHOOK_URL (its base + /w/{slug}/{marker}), so URL/method-bound
 * providers (Square, HubSpot) line up with what the browser will prefill.
 * Returns the URL the UI is expected to prefill for verification.
 */
async function sendTier2WebhookToPath(
  provider: string,
  secret: string,
  marker: string
): Promise<string> {
  const signingUrl = `${RECEIVER_BASE_URL}/w/${endpointSlug}/${marker}`;
  const postUrl = `${WEBHOOK_URL}/w/${endpointSlug}/${marker}`;
  const signed = await buildTemplateSendOptions(signingUrl, {
    provider: provider as Parameters<typeof buildTemplateSendOptions>[1]["provider"],
    secret,
    method: "POST",
  });
  const resp = await fetch(postUrl, {
    method: signed.method ?? "POST",
    headers: signed.headers as Record<string, string>,
    body: signed.body as string,
  });
  if (resp.status !== 200) {
    throw new Error(`receiver returned ${resp.status} for ${provider}`);
  }
  return signingUrl;
}

async function clearServerSigning() {
  await admin
    .from("endpoints")
    .update({ signing_provider: null, signing_secret_encrypted: null, signing_header: null })
    .eq("slug", endpointSlug);
}

// ── Endpoint Settings ──

test("signing config section is visible in endpoint settings", async ({ page }) => {
  await openDashboard(page);
  await openSettings(page);
  await expect(page.getByText("Signature Verification", { exact: true }).first()).toBeVisible();
  await expect(page.locator("#settings-signing-provider")).toBeVisible();
});

test("provider dropdown lists providers", async ({ page }) => {
  await openDashboard(page);
  await openSettings(page);
  const select = page.locator("#settings-signing-provider");
  const options = select.locator("option");
  // None + 30 verifiable named providers + generic-hmac.
  // SendGrid and Plaid are excluded from endpoint signing configuration.
  await expect(options).toHaveCount(32);
  await expect(options.nth(1)).toHaveText("Stripe");
  await expect(options.filter({ hasText: "Telegram" })).toHaveCount(1);
  await expect(options.filter({ hasText: "Bitbucket" })).toHaveCount(1);
  await expect(options.filter({ hasText: "PayPal" })).toHaveCount(1);
});

test("SendGrid IP allowlisting info is shown", async ({ page }) => {
  await openDashboard(page);
  await openSettings(page);
  // SendGrid is no longer in the dropdown but the info text is always visible
  await expect(page.locator("text=IP allowlisting")).toBeVisible();
});

test("selecting Discord changes label to Public Key", async ({ page }) => {
  await openDashboard(page);
  await openSettings(page);
  await page.selectOption("#settings-signing-provider", "discord");
  await expect(page.locator("text=Public Key")).toBeVisible();
});

test("selecting PayPal changes label to Webhook ID", async ({ page }) => {
  await openDashboard(page);
  await openSettings(page);
  await page.selectOption("#settings-signing-provider", "paypal");
  await expect(page.locator("text=Webhook ID")).toBeVisible();
});

test("configure signing secret and save", async ({ page }) => {
  await openDashboard(page);
  await openSettings(page);

  await page.selectOption("#settings-signing-provider", "standard-webhooks");
  await page.fill("#settings-signing-secret", TEST_SECRET);
  await page.click("text=Save Changes");

  // Dialog should close
  await expect(page.locator("text=Endpoint Settings")).not.toBeVisible({ timeout: 5000 });

  await expect
    .poll(async () => {
      const { data } = await admin
        .from("endpoints")
        .select("signing_provider, signing_secret_encrypted")
        .eq("id", endpointId)
        .single();

      return data?.signing_provider === "standard-webhooks" && data.signing_secret_encrypted
        ? "configured"
        : "pending";
    })
    .toBe("configured");

  // Navigate again so endpoint settings are read back from persisted state.
  await page.goto(`/dashboard?endpoint=${endpointSlug}`);
  await expect(page.locator("span.font-bold.uppercase", { hasText: "Sig Verify E2E" })).toBeVisible(
    { timeout: 10000 }
  );

  // Reopen and verify status shows configured
  await page
    .locator('[aria-label="Endpoint settings"]')
    .waitFor({ state: "visible", timeout: 5000 });
  await openSettings(page);
  await expect(page.locator("#settings-signing-provider")).toHaveValue("standard-webhooks");
  await expect(page.locator("text=Configured").first()).toBeVisible({ timeout: 5000 });
});

// ── Signature Tab ──

test("Signature tab is visible in request detail", async ({ page }) => {
  const path = `/signature-visible-${Date.now()}`;
  await insertServerVerifiedRequest({ path, verified: true });

  await openDashboard(page);

  await page.locator("button").filter({ hasText: path }).first().click();
  await expect(signatureTabButton(page)).toBeVisible();
});

test("Signature tab shows server-side valid result", async ({ page }) => {
  const path = `/signature-valid-${Date.now()}`;
  await insertServerVerifiedRequest({ path, verified: true });

  await openDashboard(page);

  await page.locator("button").filter({ hasText: path }).first().click();

  // Click Signature tab
  await signatureTabButton(page).click();

  // Should show valid result
  await expect(page.locator("text=Signature Valid").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=Standard Webhooks").first()).toBeVisible();
});

test("invalid signature shows mismatch details", async ({ page }) => {
  const path = `/signature-invalid-${Date.now()}`;
  await insertServerVerifiedRequest({ path, verified: false });

  await openDashboard(page);

  await page.locator("button").filter({ hasText: path }).first().click();
  await signatureTabButton(page).click();

  await expect(
    page.locator("text=Signature Mismatch").or(page.locator("text=Signature Invalid")).first()
  ).toBeVisible({ timeout: 5000 });
});

// ── Verification Badges ──

test("verification badges appear in request list", async ({ page }) => {
  await openDashboard(page);

  // Look for shield icons in the request list
  // ShieldCheck (valid) or ShieldAlert (invalid) should be present
  const shields = page.locator(
    'svg[class*="text-primary"][class*="h-3"], svg[class*="text-destructive"][class*="h-3"]'
  );
  await expect(shields.first()).toBeVisible({ timeout: 5000 });
});

// ── Client-side Verification ──

test("client-side verification form shown when no config", async ({ page }) => {
  // Clear signing config
  await admin
    .from("endpoints")
    .update({
      signing_provider: null,
      signing_secret_encrypted: null,
      signing_header: null,
    })
    .eq("slug", endpointSlug);

  // Send a plain webhook (no signing)
  await fetch(`${WEBHOOK_URL}/w/${endpointSlug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"type":"test.nosig"}',
  });
  await new Promise((r) => setTimeout(r, 500));

  await openDashboard(page);
  await page.locator('[class*="border-b-2"]').filter({ hasText: "POST" }).first().click();
  await signatureTabButton(page).click();

  // Should show the client-side verification form
  await expect(page.locator("text=Verify Signature")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#sig-provider").first()).toBeVisible();
  await expect(page.locator("text=never sent to our servers")).toBeVisible();
});

test("detected provider preselects manual verification when server-side verification is not configured", async ({
  page,
}) => {
  await admin
    .from("endpoints")
    .update({
      signing_provider: null,
      signing_secret_encrypted: null,
      signing_header: null,
    })
    .eq("slug", endpointSlug);

  await sendSignedWebhook(endpointSlug, true);
  await new Promise((r) => setTimeout(r, 1000));

  await openDashboard(page);
  await page.locator('[class*="border-b-2"]').filter({ hasText: "POST" }).first().click();
  await signatureTabButton(page).click();

  await expect(page.locator("text=Detected:").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=Standard Webhooks").first()).toBeVisible();
  await expect(page.locator("#sig-provider").first()).toHaveValue("standard-webhooks");
});

// ── Tier-1 providers: client-side detection + manual-verify preselect ──

test("Meta webhook is detected and preselects manual verification to meta", async ({ page }) => {
  await admin
    .from("endpoints")
    .update({ signing_provider: null, signing_secret_encrypted: null, signing_header: null })
    .eq("slug", endpointSlug);

  const marker = `meta-${Date.now()}`;
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "messages" }] }],
  });
  const sig = createHmac("sha256", "meta_app_secret").update(body).digest("hex");
  await fetch(`${WEBHOOK_URL}/w/${endpointSlug}/${marker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hub-signature-256": `sha256=${sig}` },
    body,
  });
  await new Promise((r) => setTimeout(r, 1000));

  await openDashboard(page);
  await page.locator("button").filter({ hasText: marker }).first().click();
  await signatureTabButton(page).click();

  await expect(page.locator("text=Detected:").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#sig-provider").first()).toHaveValue("meta");
});

test("Coinbase Commerce webhook is detected and preselects manual verification", async ({
  page,
}) => {
  await admin
    .from("endpoints")
    .update({ signing_provider: null, signing_secret_encrypted: null, signing_header: null })
    .eq("slug", endpointSlug);

  const marker = `cbc-${Date.now()}`;
  const body = JSON.stringify({
    event: { type: "charge:confirmed", data: { code: "ABC123" } },
  });
  const sig = createHmac("sha256", "cb_secret").update(body).digest("hex");
  await fetch(`${WEBHOOK_URL}/w/${endpointSlug}/${marker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cc-webhook-signature": sig },
    body,
  });
  await new Promise((r) => setTimeout(r, 1000));

  await openDashboard(page);
  await page.locator("button").filter({ hasText: marker }).first().click();
  await signatureTabButton(page).click();

  await expect(page.locator("text=Detected:").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#sig-provider").first()).toHaveValue("coinbase-commerce");
});

// ── Tier-2 providers: end-to-end server-side verification through the receiver ──

test("Square webhook verifies server-side end-to-end (URL-aware scheme)", async ({ page }) => {
  // Square signs notificationURL + body, so the receiver must supply the capture
  // URL for verification. Configure server-side signing, then POST a signed
  // template and confirm the dashboard shows a valid result + the Square badge.
  await configureServerSigning("square", "sq_signature_key");
  await sendTier2Webhook("square", "sq_signature_key");

  // The receiver verifies asynchronously; the request row gets the result shortly.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("requests")
          .select("signature_verified, signing_provider")
          .eq("endpoint_id", endpointId)
          .eq("signing_provider", "square")
          .order("received_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return data?.signature_verified === true ? "valid" : "pending";
      },
      { timeout: 10000 }
    )
    .toBe("valid");

  await openDashboard(page);
  await page.locator('[class*="border-b-2"]').filter({ hasText: "POST" }).first().click();
  await signatureTabButton(page).click();

  await expect(page.locator("text=Signature Valid").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=Square").first()).toBeVisible();
});

test("Calendly webhook verifies server-side end-to-end (Stripe-style t=,v1= scheme)", async ({
  page,
}) => {
  await configureServerSigning("calendly", "cal_signing_key");
  await sendTier2Webhook("calendly", "cal_signing_key");

  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("requests")
          .select("signature_verified, signing_provider")
          .eq("endpoint_id", endpointId)
          .eq("signing_provider", "calendly")
          .order("received_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return data?.signature_verified === true ? "valid" : "pending";
      },
      { timeout: 10000 }
    )
    .toBe("valid");

  await openDashboard(page);
  await page.locator('[class*="border-b-2"]').filter({ hasText: "POST" }).first().click();
  await signatureTabButton(page).click();

  await expect(page.locator("text=Signature Valid").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=Calendly").first()).toBeVisible();
});

// ── Tier-2 request-context providers: in-browser manual verification ──
// Square/HubSpot sign the request URL (HubSpot also the method), so the
// manual-verify UI must expose a URL (and method) field and thread them into
// verifySignature(). Without it, selecting these providers throws
// "...requires options.url" instead of producing a real result.

test("Square manual verification (client-side) verifies with the prefilled URL", async ({
  page,
}) => {
  await clearServerSigning();
  const marker = `sq-manual-${Date.now()}`;
  const signingUrl = await sendTier2WebhookToPath("square", "sq_signature_key", marker);
  await new Promise((r) => setTimeout(r, 1000));

  await openDashboard(page);
  await page.locator("button").filter({ hasText: marker }).first().click();
  await signatureTabButton(page).click();

  // Manual-verify form is shown (no server-side config).
  await expect(page.locator("text=Verify Signature").first()).toBeVisible({ timeout: 5000 });
  await page.locator("#sig-provider").first().selectOption("square");

  // The URL field should be present and prefilled to the receiver's capture URL.
  await expect(page.locator("#sig-url").first()).toBeVisible();
  await expect(page.locator("#sig-url").first()).toHaveValue(signingUrl);

  await page.locator("#sig-secret").first().fill("sq_signature_key");
  await page
    .getByRole("button", { name: /^verify$/i })
    .first()
    .click();

  await expect(page.locator("text=Signature Valid").first()).toBeVisible({ timeout: 5000 });
});

test("HubSpot manual verification (client-side) verifies with the URL + method", async ({
  page,
}) => {
  await clearServerSigning();
  const marker = `hs-manual-${Date.now()}`;
  const signingUrl = await sendTier2WebhookToPath("hubspot", "hs_client_secret", marker);
  await new Promise((r) => setTimeout(r, 1000));

  await openDashboard(page);
  await page.locator("button").filter({ hasText: marker }).first().click();
  await signatureTabButton(page).click();

  await expect(page.locator("text=Verify Signature").first()).toBeVisible({ timeout: 5000 });
  await page.locator("#sig-provider").first().selectOption("hubspot");

  // HubSpot exposes both a URL field (prefilled) and a method field (default POST).
  await expect(page.locator("#sig-url").first()).toHaveValue(signingUrl);
  await expect(page.locator("#sig-method").first()).toHaveValue("POST");

  await page.locator("#sig-secret").first().fill("hs_client_secret");
  await page
    .getByRole("button", { name: /^verify$/i })
    .first()
    .click();

  await expect(page.locator("text=Signature Valid").first()).toBeVisible({ timeout: 5000 });
});
