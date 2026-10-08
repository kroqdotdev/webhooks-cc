import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { verifyStandardWebhookSignature } from "@webhooks-cc/sdk";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

/**
 * Email forwarding end to end against a local server standing in for the
 * user's: settings, the secret, a test delivery, a captured email forwarded
 * by the dev server's worker, and a redelivery. Needs the dev server started
 * with FORWARDING_ALLOW_PRIVATE_TARGETS=true (as in .env.local) so it may
 * post to 127.0.0.1.
 */

test.describe.configure({ mode: "serial" });

let testUser: TestUser;
let endpointSlug: string;
let endpointId: string;
let server: Server;
let hookUrl: string;
let secret: string;
const received: { headers: IncomingHttpHeaders; body: string }[] = [];

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
    .insert({ slug: `e2e-fwd-${Date.now()}`, name: "Forwarding E2E", user_id: testUser.id })
    .select("id, slug")
    .single();
  if (error) throw error;
  endpointSlug = data.slug;
  endpointId = data.id;

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end('{"received":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/email`;
});

test.afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  if (endpointId) {
    await admin.from("endpoints").update({ forward_enabled: false }).eq("id", endpointId);
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  if (testUser) await deleteTestUser(testUser.id);
});

/** The dashboard renders the detail for desktop and mobile; only one is shown. */
function shown(locator: Locator) {
  return locator.filter({ visible: true });
}

async function openSettings(page: Page) {
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.locator("span.font-bold.caps", { hasText: "Forwarding E2E" })).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Settings" })
    .click();
  const section = page.getByRole("region", { name: "Forwarding" });
  await expect(section).toBeVisible();
  return section;
}

async function captureEmail(subject: string) {
  const to = `${endpointSlug}@mailhooks.cc`;
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: endpointSlug,
    p_method: "EMAIL",
    p_path: to,
    p_headers: { subject },
    p_body: `Subject: ${subject}\r\n\r\nYour code is 482913.\r\n`,
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
    p_kind: "email",
    p_email: {
      subject,
      from: [{ name: "Tidewater", address: "no-reply@tidewater.app" }],
      to: [{ name: null, address: to }],
      text: "Your code is 482913.",
    },
    p_dedupe_key: null,
    p_retry: false,
    p_size: null,
  });
  if (error) throw error;
  return (data as { request_id: string }).request_id;
}

test("set up forwarding: URL, secret, a test delivery, then on", async ({ page }) => {
  const section = await openSettings(page);

  await section.getByLabel("URL").fill(hookUrl);
  await section.getByRole("button", { name: "Save changes" }).click();
  await expect(section.getByText("Saved.")).toBeVisible({ timeout: 10000 });

  // The first URL brings a secret, before forwarding is on.
  await section.getByRole("button", { name: "Reveal" }).click();
  const shownSecret = section.locator("code", { hasText: /^whsec_/ });
  await expect(shownSecret).toHaveText(/^whsec_[A-Za-z0-9+/]{32}$/);
  secret = (await shownSecret.textContent())!;

  // A test delivery: no email yet, so a signed sample.
  await section.getByRole("button", { name: "Send test delivery" }).click();
  await expect(section.getByText(/^Delivered: 200 in \d+ ms/)).toBeVisible({ timeout: 20000 });
  await expect(section.getByText('{"received":true}')).toBeVisible();
  const sample = received.at(-1)!;
  expect(JSON.parse(sample.body)).toMatchObject({ type: "email.received", data: { test: true } });
  expect(
    await verifyStandardWebhookSignature(
      sample.body,
      sample.headers as Record<string, string>,
      secret
    )
  ).toBe(true);

  await section.getByRole("switch", { name: "Forward emails as JSON" }).click();
  await section.getByRole("button", { name: "Save changes" }).click();
  await expect(section.getByText("Saved.")).toBeVisible({ timeout: 10000 });
  const { data } = await admin
    .from("endpoints")
    .select("forward_enabled, forward_url")
    .eq("id", endpointId)
    .single();
  expect(data).toEqual({ forward_enabled: true, forward_url: hookUrl });
});

test("a captured email is forwarded, shown as delivered, and can be sent again", async ({
  page,
}) => {
  const before = received.length;
  const requestId = await captureEmail("Forward me");

  // The dev server's worker picks it up within a few seconds.
  await expect.poll(() => received.length, { timeout: 20000 }).toBeGreaterThan(before);
  const delivery = received.at(-1)!;
  const body = JSON.parse(delivery.body);
  expect(body).toMatchObject({
    type: "email.received",
    data: { id: requestId, subject: "Forward me", codes: ["482913"], test: false },
  });
  expect(delivery.headers["webhook-id"]).toBe(`msg_${requestId.replace(/-/g, "")}`);
  expect(
    await verifyStandardWebhookSignature(
      delivery.body,
      delivery.headers as Record<string, string>,
      secret
    )
  ).toBe(true);

  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await page.getByRole("button", { name: /^EMAIL Forward me/ }).click();
  await expect(shown(page.getByText("Forwarded as this JSON to"))).toBeVisible({
    timeout: 15000,
  });
  await shown(page.getByRole("button", { name: /^Deliveries$/i })).click();
  await expect(shown(page.getByText("Delivered", { exact: true }))).toBeVisible();
  await expect(shown(page.getByText("1 try"))).toBeVisible();

  // Redeliver: the same email, the same webhook-id, a second delivery.
  const beforeRedelivery = received.length;
  await shown(page.getByRole("button", { name: "Redeliver" })).click();
  await expect.poll(() => received.length, { timeout: 20000 }).toBeGreaterThan(beforeRedelivery);
  expect(received.at(-1)!.headers["webhook-id"]).toBe(delivery.headers["webhook-id"]);
  await expect(shown(page.getByText("Delivered", { exact: true }))).toHaveCount(2, {
    timeout: 15000,
  });
});

test("turning forwarding off stops it", async ({ page }) => {
  const section = await openSettings(page);
  await section.getByRole("switch", { name: "Forward emails as JSON" }).click();
  await section.getByRole("button", { name: "Save changes" }).click();
  await expect(section.getByText("Saved.")).toBeVisible({ timeout: 10000 });

  const before = received.length;
  await captureEmail("Not forwarded");
  const { count } = await admin
    .from("email_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("endpoint_id", endpointId)
    .eq("status", "pending");
  expect(count).toBe(0);
  await page.waitForTimeout(3000);
  expect(received.length).toBe(before);
});
