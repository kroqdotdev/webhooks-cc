import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

/**
 * Named email fields and a mail provider's shape end to end: a field defined
 * in Settings (with what it finds shown as it is typed), the field and the
 * reply on the email, and a destination posting a captured email the way
 * Postmark does to a local server. Needs the dev server started with
 * FORWARDING_ALLOW_PRIVATE_TARGETS=true (as in .env.local).
 */

test.describe.configure({ mode: "serial" });

let testUser: TestUser;
let endpointSlug: string;
let endpointId: string;
let server: Server;
let hookUrl: string;
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
    .insert({ slug: `e2e-fields-${Date.now()}`, name: "Fields E2E", user_id: testUser.id })
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
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/inbound/postmark`;
});

test.afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  if (endpointId) {
    await admin
      .from("endpoint_destinations")
      .update({ enabled: false })
      .eq("endpoint_id", endpointId);
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  if (testUser) await deleteTestUser(testUser.id);
});

/** The dashboard renders the detail for desktop and mobile; only one is shown. */
function shown(locator: Locator) {
  return locator.filter({ visible: true });
}

async function openSettings(page: Page, section: string) {
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.locator("span.font-bold.caps", { hasText: "Fields E2E" })).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Settings" })
    .click();
  const region = page.getByRole("region", { name: section });
  await expect(region).toBeVisible();
  return region;
}

async function captureReply() {
  const to = `${endpointSlug}+inv@mailhooks.cc`;
  const text =
    "Paid this morning, thanks!\n\nOn Sat, 24 Oct 2026 at 18:02, Acme Billing <billing@acme.example> wrote:\n> Invoice INV-2041\n> Total: 42.00 EUR\n";
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: endpointSlug,
    p_method: "EMAIL",
    p_path: to,
    p_headers: { subject: "Re: Invoice INV-2041", from: "Acme Billing <billing@acme.example>" },
    p_body: `From: Acme Billing <billing@acme.example>\r\nSubject: Re: Invoice INV-2041\r\n\r\n${text.replace(/\n/g, "\r\n")}`,
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
    p_kind: "email",
    p_email: {
      subject: "Re: Invoice INV-2041",
      from: [{ name: "Acme Billing", address: "billing@acme.example" }],
      to: [{ name: null, address: to }],
      tag: "inv",
      text,
    },
    p_dedupe_key: null,
    p_retry: false,
    p_size: null,
  });
  if (error) throw error;
  return (data as { request_id: string }).request_id;
}

test("a field shows what it finds as it is typed, and saves", async ({ page }) => {
  await captureReply();
  const receiving = await openSettings(page, "Receiving");

  await receiving.getByRole("button", { name: "Add field" }).click();
  await receiving.getByLabel("Field 1: name").fill("invoice");
  await receiving.getByLabel("Field 1: pattern").fill("(INV-\\d+)");
  await expect(receiving.getByText("INV-2041", { exact: true })).toBeVisible({ timeout: 10000 });

  // RE2 has no lookbehind: the row says so and what to do instead.
  await receiving.getByLabel("Field 1: pattern").fill("(?<=Invoice )INV-\\d+");
  await expect(receiving.getByText(/lookahead and lookbehind are not supported/)).toBeVisible({
    timeout: 10000,
  });
  await receiving.getByLabel("Field 1: pattern").fill("(INV-\\d+)");
  await expect(receiving.getByText("INV-2041", { exact: true })).toBeVisible({ timeout: 10000 });

  await receiving.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(
      async () =>
        (await admin.from("endpoints").select("email_fields").eq("id", endpointId).single()).data
          ?.email_fields
    )
    .toEqual([{ name: "invoice", from: "subject", pattern: "(INV-\\d+)" }]);
});

test("the email shows the field and the reply on its own", async ({ page }) => {
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await shown(page.getByRole("button", { name: /Re: Invoice INV-2041/ }))
    .first()
    .click();
  const found = shown(page.getByText("Found in this email"));
  await expect(found).toBeVisible({ timeout: 15000 });
  await expect(shown(page.getByRole("button", { name: "Copy invoice" }))).toBeVisible();

  await shown(page.getByRole("button", { name: "Text", exact: true })).click();
  await shown(page.getByRole("button", { name: "Reply only" })).click();
  await expect(shown(page.getByText("Paid this morning, thanks!", { exact: true }))).toBeVisible();
  await expect(shown(page.getByText("> Total: 42.00 EUR"))).toHaveCount(0);
});

test("an inbound email handler destination posts emails as Postmark does", async ({ page }) => {
  const forwarding = await openSettings(page, "Forwarding");
  await forwarding.getByRole("button", { name: /^Inbound email handler/ }).click();
  await forwarding.getByLabel("Send to").fill(hookUrl);
  await expect(forwarding.getByLabel("Shaped like")).toHaveValue("postmark");
  await forwarding.getByRole("button", { name: "Add destination" }).click();
  await expect
    .poll(
      async () =>
        (
          await admin
            .from("endpoint_destinations")
            .select("format, http, email")
            .eq("endpoint_id", endpointId)
            .maybeSingle()
        ).data
    )
    .toEqual({ format: "postmark", http: false, email: true });

  const id = await captureReply();
  await expect
    .poll(() => received.some((r) => r.body.includes("StrippedTextReply")), { timeout: 30000 })
    .toBe(true);
  const delivery = received.find((r) => r.body.includes("StrippedTextReply"))!;
  expect(delivery.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(delivery.body)).toMatchObject({
    MessageID: id,
    MailboxHash: "inv",
    StrippedTextReply: "Paid this morning, thanks!",
    Attachments: [],
  });
});
