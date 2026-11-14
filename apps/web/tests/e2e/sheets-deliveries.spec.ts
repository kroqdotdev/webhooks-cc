import { test, expect, type Locator } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

/**
 * An endpoint whose only destination is a Google Sheets one (a common
 * mailhooks.cc setup) keeps its Deliveries tabs, on an HTTP request and on
 * an email, although its old forward* fields read as not forwarding: they
 * stand for a destination that sends to a URL, which a Sheets destination
 * never is. The destination is switched off, so nothing tries Google.
 */

test.describe.configure({ mode: "serial" });

let owner: TestUser;
let endpointSlug: string;
let endpointId: string;

test.beforeAll(async () => {
  owner = await createTestUser();
  await admin
    .from("users")
    .update({
      plan: "pro",
      request_limit: 10000,
      requests_used: 0,
      period_end: new Date(Date.now() + 86400000).toISOString(),
    })
    .eq("id", owner.id);
  const { data, error } = await admin
    .from("endpoints")
    .insert({ slug: `e2e-sheets-${Date.now()}`, name: "Sheets only E2E", user_id: owner.id })
    .select("id, slug")
    .single();
  if (error) throw error;
  endpointSlug = data.slug;
  endpointId = data.id;
  const spreadsheetId = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const { error: destinationError } = await admin.from("endpoint_destinations").insert({
    endpoint_id: endpointId,
    position: 0,
    name: "Orders sheet",
    enabled: false,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    http: true,
    email: true,
    format: "sheets",
    config: {
      connectionId: "4b3a2f1e-0d9c-4b8a-9f7e-6d5c4b3a2f1e",
      spreadsheetId,
      sheet: "Sheet1",
      rows: "email",
      columns: [{ header: "Subject", value: "{{ subject }}" }],
    },
  });
  if (destinationError) throw destinationError;
});

test.afterAll(async () => {
  if (endpointId) {
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  if (owner) await deleteTestUser(owner.id);
});

/** The dashboard renders the detail for desktop and mobile; only one is shown. */
function shown(locator: Locator) {
  return locator.filter({ visible: true });
}

async function capture(kind: "http" | "email", subject: string) {
  const to = `${endpointSlug}@mailhooks.cc`;
  const { error } = await admin.rpc("capture_webhook", {
    p_slug: endpointSlug,
    p_method: kind === "email" ? "EMAIL" : "POST",
    p_path: kind === "email" ? to : "/orders",
    p_headers: kind === "email" ? { subject } : { "content-type": "application/json" },
    p_body: kind === "email" ? `Subject: ${subject}\r\n\r\nOrder 1042.\r\n` : '{"order":"1042"}',
    p_query_params: {},
    p_content_type: kind === "email" ? "message/rfc822" : "application/json",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
    p_kind: kind,
    p_email:
      kind === "email"
        ? {
            subject,
            from: [{ name: "Acme Orders", address: "orders@acme.example" }],
            to: [{ name: null, address: to }],
            text: "Order 1042.",
          }
        : null,
    p_dedupe_key: null,
    p_retry: false,
    p_size: null,
  });
  if (error) throw error;
}

test("a Sheets-only endpoint keeps the Deliveries tab on requests and emails", async ({
  page,
}, testInfo) => {
  await capture("http", "");
  await capture("email", "Order 1042");

  await signInTestUser(page, owner, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sheets only E2E" })).toBeVisible({
    timeout: 15000,
  });

  await page.getByRole("option", { name: /^POST \/orders/ }).click();
  await expect(shown(page.getByRole("tab", { name: /^deliveries$/i }))).toBeVisible({
    timeout: 15000,
  });

  await page.getByRole("option", { name: /^EMAIL Order 1042/ }).click();
  // The JSON pane speaks of the destinations, not of setting up forwarding.
  await expect(shown(page.getByText(/^Destinations set to signed JSON get this JSON/))).toBeVisible(
    { timeout: 15000 }
  );
  await expect(shown(page.getByText("Forwarding can POST this JSON"))).toHaveCount(0);
  const tab = shown(page.getByRole("tab", { name: /^Deliveries$/i }));
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(shown(page.getByText(/^Loading/))).toHaveCount(0, { timeout: 15000 });
  await page.screenshot({ path: testInfo.outputPath("sheets-only-deliveries.png") });
});
