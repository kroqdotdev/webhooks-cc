import { test, expect } from "@playwright/test";
import { createHmac } from "crypto";
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
  // Should have None + 28 providers (27 verifiable named providers + generic-hmac;
  // SendGrid is excluded — it uses IP allowlisting, not signatures).
  await expect(options).toHaveCount(29);
  await expect(options.nth(1)).toHaveText("Stripe");
  await expect(options.filter({ hasText: "Telegram" })).toHaveCount(1);
  await expect(options.filter({ hasText: "Bitbucket" })).toHaveCount(1);
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
