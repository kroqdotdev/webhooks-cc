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

// ── Endpoint Settings ──

test("signing config section is visible in endpoint settings", async ({ page }) => {
  await openDashboard(page);
  await openSettings(page);
  await expect(page.locator("text=Signature Verification")).toBeVisible();
  await expect(page.locator("#settings-signing-provider")).toBeVisible();
});

test("provider dropdown lists providers", async ({ page }) => {
  await openDashboard(page);
  await openSettings(page);
  const select = page.locator("#settings-signing-provider");
  const options = select.locator("option");
  // Should have None + 14 providers (SendGrid removed — uses IP allowlisting)
  await expect(options).toHaveCount(15);
  await expect(options.nth(1)).toHaveText("Stripe");
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

  // Reopen and verify status shows configured
  await page
    .locator('[aria-label="Endpoint settings"]')
    .waitFor({ state: "visible", timeout: 5000 });
  await openSettings(page);
  await expect(page.locator("text=Configured")).toBeVisible({ timeout: 5000 });
});

// ── Signature Tab ──

test("Signature tab is visible in request detail", async ({ page }) => {
  // Send a webhook first so we have a request to select
  await sendSignedWebhook(endpointSlug, true);
  await new Promise((r) => setTimeout(r, 1000));

  await openDashboard(page);

  // Click the first request
  await page.locator('[class*="border-b-2"]').filter({ hasText: "POST" }).first().click();
  await expect(page.locator("button", { hasText: "SIGNATURE" })).toBeVisible();
});

test("Signature tab shows server-side valid result", async ({ page }) => {
  await openDashboard(page);

  // Click the first request (should be the verified one)
  await page.locator('[class*="border-b-2"]').filter({ hasText: "POST" }).first().click();

  // Click Signature tab
  await page.click("button:has-text('SIGNATURE')");

  // Should show valid result
  await expect(page.locator("text=Signature Valid")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=Standard Webhooks").first()).toBeVisible();
});

test("invalid signature shows mismatch details", async ({ page }) => {
  // Send an invalid webhook
  await sendSignedWebhook(endpointSlug, false);
  await new Promise((r) => setTimeout(r, 1000));

  await openDashboard(page);

  // Select the most recent request (the invalid one)
  await page.locator('[class*="border-b-2"]').filter({ hasText: "POST" }).first().click();
  await page.click("button:has-text('SIGNATURE')");

  await expect(
    page.locator("text=Signature Mismatch").or(page.locator("text=Signature Invalid"))
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
  await page.click("button:has-text('SIGNATURE')");

  // Should show the client-side verification form
  await expect(page.locator("text=Verify Signature")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#sig-provider")).toBeVisible();
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
  await page.click("button:has-text('SIGNATURE')");

  await expect(page.locator("text=Detected:")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=Standard Webhooks")).toBeVisible();
  await expect(page.locator("#sig-provider")).toHaveValue("standard-webhooks");
});
