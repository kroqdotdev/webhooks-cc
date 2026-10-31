import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

/**
 * Layouts end to end: one built in Settings and tried on a captured email
 * as it is typed (its match, a field and line items from the text), saved,
 * and a new email parsed by the dev server's parse worker and shown on the
 * Parsed tab.
 */

test.describe.configure({ mode: "serial" });

let testUser: TestUser;
let endpointSlug: string;
let endpointId: string;

test.beforeAll(async () => {
  testUser = await createTestUser();
  await admin
    .from("users")
    .update({
      plan: "pro",
      request_limit: 10000,
      requests_used: 0,
      period_start: new Date(Date.now() - 86400000).toISOString(),
      period_end: new Date(Date.now() + 86400000).toISOString(),
    })
    .eq("id", testUser.id);
  const { data, error } = await admin
    .from("endpoints")
    .insert({ slug: `e2e-layouts-${Date.now()}`, name: "Layouts E2E", user_id: testUser.id })
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
  if (testUser) await deleteTestUser(testUser.id);
});

function shown(locator: Locator) {
  return locator.filter({ visible: true });
}

async function captureOrder(order: number) {
  const subject = `Order ${order} confirmed`;
  const text = `Thanks for your order.\nItems:\nA-1 x2\nB-22 x10\nThanks, Acme\n`;
  const { error } = await admin.rpc("capture_webhook", {
    p_slug: endpointSlug,
    p_method: "EMAIL",
    p_path: `${endpointSlug}@mailhooks.cc`,
    p_headers: { subject, from: "Acme <orders@acme.example>" },
    p_body: `Subject: ${subject}\r\n\r\n${text.replace(/\n/g, "\r\n")}`,
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
    p_kind: "email",
    p_email: {
      subject,
      from: [{ name: "Acme", address: "orders@acme.example" }],
      to: [{ name: null, address: `${endpointSlug}@mailhooks.cc` }],
      text,
    },
    p_dedupe_key: null,
    p_retry: false,
    p_size: null,
  });
  if (error) throw error;
}

async function openLayouts(page: Page) {
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.locator("span.font-bold.caps", { hasText: "Layouts E2E" })).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Settings" })
    .click();
  const region = page.getByRole("region", { name: "Layouts" });
  await expect(region).toBeVisible();
  return region;
}

test("a layout is tried on a captured email as it is built, then saved", async ({ page }) => {
  await captureOrder(1001);
  const layouts = await openLayouts(page);

  await layouts.getByRole("button", { name: "Add layout" }).click();
  await layouts.getByLabel("Layout 1: name").fill("Acme orders");
  await layouts.getByRole("button", { name: "Add field" }).click();
  await layouts.getByLabel("Field 1: name").fill("order");
  await layouts.getByLabel("Field 1: pattern").fill("Order (\\d+)");
  await layouts
    .getByRole("radiogroup", { name: "Layout 1: line items" })
    .getByRole("radio", { name: "From the text" })
    .click();
  await layouts
    .getByLabel("Layout 1: line item pattern")
    .fill("(?P<sku>[A-Z]-\\d+) x(?P<qty>\\d+)");
  await layouts.getByLabel("Layout 1: start after").fill("Items:");

  // The preview runs the draft on the newest email.
  await expect(layouts.getByText("matches the email below")).toBeVisible({ timeout: 10000 });
  await expect(layouts.getByRole("cell", { name: "B-22" })).toBeVisible();
  await expect(layouts.getByRole("cell", { name: "10" })).toBeVisible();
  const header = layouts.getByRole("columnheader");
  await expect(header).toHaveText(["sku", "qty"]);

  await layouts.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(async () => {
      const { data } = await admin
        .from("endpoints")
        .select("layouts")
        .eq("id", endpointId)
        .single();
      const saved = (data?.layouts ?? []) as { name: string; lineItems?: { from: string } }[];
      return saved.map((layout) => [layout.name, layout.lineItems?.from]);
    })
    .toEqual([["Acme orders", "text"]]);
});

test("a new email is parsed and opens on the Parsed tab", async ({ page }) => {
  await captureOrder(1002);
  // The dev server's parse worker picks the job up within a second or two.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("request_parses")
          .select("status")
          .eq("endpoint_id", endpointId)
          .eq("status", "done");
        return data?.length ?? 0;
      },
      { timeout: 30000 }
    )
    .toBeGreaterThan(0);

  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await shown(page.getByRole("button", { name: /Order 1002 confirmed/ }))
    .first()
    .click();
  await expect(shown(page.getByRole("button", { name: "Parsed", exact: true }))).toBeVisible({
    timeout: 15000,
  });
  await expect(shown(page.getByText("Acme orders", { exact: true }))).toBeVisible();
  await expect(shown(page.getByRole("cell", { name: "A-1" }))).toBeVisible();
});
