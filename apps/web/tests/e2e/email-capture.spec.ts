import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

// Tests share one endpoint and one of them flips an endpoint setting.
test.describe.configure({ mode: "serial" });

let testUser: TestUser;
let endpointSlug: string;
let endpointId: string;

const SUBJECT = "Confirm your email for Tidewater";
const CODE = "482913";
const CONFIRM_URL = "https://app.tidewater.app/confirm?token=Zk3q9v";
const HTML = [
  '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px">',
  '<img src="https://tidewater.app/logo.png" alt="Tidewater" width="120">',
  "<h1>Confirm your email</h1><p>Your confirmation code is</p>",
  `<p style="font-size:32px;font-weight:bold">${CODE}</p>`,
  `<p><a href="${CONFIRM_URL}">Confirm email</a></p>`,
  '<img src="https://track.tidewater.app/open/8f3a.gif" width="1" height="1">',
  "</div>",
].join("");
const TEXT = `Your confirmation code is ${CODE}.\n\nOr confirm with this link: ${CONFIRM_URL}\n`;

async function insertEmail(slug: string) {
  const to = `${slug}+signup@mailhooks.cc`;
  const raw = [
    "From: Tidewater <no-reply@tidewater.app>",
    `To: ${to}`,
    `Subject: ${SUBJECT}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    HTML,
    "",
  ].join("\r\n");
  const { error } = await admin.from("requests").insert({
    endpoint_id: endpointId,
    user_id: testUser.id,
    method: "EMAIL",
    path: to,
    headers: {
      from: "Tidewater <no-reply@tidewater.app>",
      to,
      subject: SUBJECT,
      "content-type": "text/html; charset=utf-8",
    },
    body: raw,
    query_params: {},
    content_type: "message/rfc822",
    ip: "127.0.0.1",
    size: Buffer.byteLength(raw),
    received_at: new Date().toISOString(),
    kind: "email",
    email: {
      subject: SUBJECT,
      from: [{ name: "Tidewater", address: "no-reply@tidewater.app" }],
      to: [{ name: null, address: to }],
      cc: [],
      reply_to: [],
      sender: [],
      tag: "signup",
      date: new Date().toISOString(),
      message_id: `e2e-${Date.now()}@tidewater.app`,
      in_reply_to: [],
      text: TEXT,
      html: HTML,
      text_from_html: false,
      attachments: [],
      auth: {
        spf: { result: "pass", domain: "tidewater.app" },
        dkim: [{ result: "pass", domain: "tidewater.app", selector: "s1" }],
        dmarc: {
          result: "pass",
          domain: "tidewater.app",
          policy: "reject",
          spf: "pass",
          dkim: "pass",
        },
        iprev: { result: "pass", ptr: "mail.tidewater.app" },
      },
      smtp: {
        helo: "mail.tidewater.app",
        client_ip: "127.0.0.1",
        client_rdns: "mail.tidewater.app",
        envelope_from: "no-reply@tidewater.app",
        envelope_to: [to],
        size: Buffer.byteLength(raw),
        tls: { version: "TLSv1.3", cipher: "TLS_AES_256_GCM_SHA384" },
      },
      parse_error: false,
      raw_truncated: false,
      text_truncated: false,
      html_truncated: false,
      headers_oversized: false,
      addresses_truncated: false,
      attachments_truncated: false,
    },
  });
  if (error) throw error;
}

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
    .insert({ slug: `e2e-mail-${Date.now()}`, name: "Mail E2E", user_id: testUser.id })
    .select("id, slug")
    .single();
  if (error) throw error;
  endpointSlug = data.slug;
  endpointId = data.id;

  const { error: httpError } = await admin.from("requests").insert({
    endpoint_id: endpointId,
    user_id: testUser.id,
    method: "POST",
    path: "/hooks/orders",
    headers: { "content-type": "application/json" },
    body: '{"type":"order.created"}',
    query_params: {},
    content_type: "application/json",
    ip: "127.0.0.1",
    size: 24,
    received_at: new Date(Date.now() - 60_000).toISOString(),
  });
  if (httpError) throw httpError;
  await insertEmail(endpointSlug);
});

test.afterAll(async () => {
  if (endpointId) {
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  if (testUser) await deleteTestUser(testUser.id);
});

async function openDashboard(
  page: Page,
  look: { style: "classic" | "clean"; theme: "light" | "dark" } = {
    style: "classic",
    theme: "light",
  }
) {
  await page.addInitScript(({ style, theme }) => {
    localStorage.setItem("ui-style", style);
    localStorage.setItem("ui-style-source", "chosen");
    localStorage.setItem("theme", theme);
  }, look);
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.locator("span.font-bold.caps", { hasText: "Mail E2E" })).toBeVisible({
    timeout: 15000,
  });
}

/** The dashboard renders the detail for desktop and mobile; only one is shown. */
function shown(locator: Locator) {
  return locator.filter({ visible: true });
}

function httpRow(page: Page) {
  return page.getByRole("button", { name: /^POST \/hooks\/orders/ });
}

function emailRow(page: Page) {
  return page.getByRole("button", { name: new RegExp(`EMAIL ${SUBJECT}`) });
}

for (const style of ["classic", "clean"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`email view works in ${style} ${theme}`, async ({ page }) => {
      await openDashboard(page, { style, theme });
      await expect(page.locator("html")).toHaveAttribute("data-style", style);

      // The endpoint bar shows the email address next to the HTTP URL
      await expect(page.getByText(`${endpointSlug}@mailhooks.cc`).first()).toBeVisible();

      await emailRow(page).click();
      await expect(shown(page.getByRole("heading", { name: SUBJECT }))).toBeVisible();

      // Found in this email: the code and the confirm link
      await expect(shown(page.getByText("Found in this email"))).toBeVisible();
      await expect(shown(page.getByText(CODE, { exact: true })).first()).toBeVisible();
      await expect(
        shown(page.getByRole("link", { name: "Open link in a new tab" }))
      ).toHaveAttribute("href", CONFIRM_URL);

      // The preview is sandboxed without scripts, and remote images wait for a click
      const frame = shown(page.locator('iframe[title="Email preview"]'));
      await expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
      await expect(shown(page.getByText("2 remote images are blocked"))).toBeVisible();
      await expect(frame.contentFrame().getByText("Confirm your email")).toBeVisible();
      await shown(page.getByRole("button", { name: "Load images" })).click();
      await expect(shown(page.getByText("2 remote images are blocked"))).toHaveCount(0);

      await shown(page.getByRole("button", { name: /^Authentication$/i })).click();
      await expect(shown(page.getByText("SPF", { exact: true })).first()).toBeVisible();

      await shown(page.getByRole("button", { name: /^Raw$/i })).click();
      await expect(shown(page.getByText(`Subject: ${SUBJECT}`))).toBeVisible();
    });
  }
}

test("the kind switch filters the list", async ({ page }) => {
  await openDashboard(page);
  const show = page.getByRole("radiogroup", { name: "Show" });

  // The selected HTTP request leaves with the filter; the email takes its place.
  await httpRow(page).click();
  await show.getByRole("radio", { name: /^Email/ }).click();
  await expect(emailRow(page)).toBeVisible();
  await expect(httpRow(page)).not.toBeVisible();
  await expect(shown(page.getByRole("heading", { name: SUBJECT }))).toBeVisible();

  await show.getByRole("radio", { name: /^HTTP/ }).click();
  await expect(httpRow(page)).toBeVisible();
  await expect(emailRow(page)).not.toBeVisible();

  await show.getByRole("radio", { name: /^All/ }).click();
  await expect(emailRow(page)).toBeVisible();
  await expect(httpRow(page)).toBeVisible();
});

test("codes and links can be turned off for the endpoint", async ({ page }) => {
  await openDashboard(page);
  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Settings" })
    .click();

  const receiving = page.getByRole("region", { name: "Receiving" });
  await receiving.getByRole("switch", { name: "Show codes and links found in emails" }).click();
  await receiving.getByRole("button", { name: "Save changes" }).click();
  await expect(receiving.getByText("Saved.")).toBeVisible({ timeout: 10000 });

  await expect
    .poll(async () => {
      const { data } = await admin
        .from("endpoints")
        .select("show_email_extracts")
        .eq("id", endpointId)
        .single();
      return data?.show_email_extracts;
    })
    .toBe(false);

  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Requests" })
    .click();
  await emailRow(page).click();
  await expect(shown(page.getByRole("heading", { name: SUBJECT }))).toBeVisible();
  await expect(shown(page.getByText("Found in this email"))).toHaveCount(0);
});

test("the email switch reaches emails older than the newest page", async ({ page }) => {
  // 55 HTTP requests newer than the email push it off the first page of 50.
  const base = Date.now();
  const { error } = await admin.from("requests").insert(
    Array.from({ length: 55 }, (_, i) => ({
      endpoint_id: endpointId,
      user_id: testUser.id,
      method: "POST",
      path: `/bulk/${i}`,
      headers: { "content-type": "application/json" },
      body: "{}",
      query_params: {},
      content_type: "application/json",
      ip: "127.0.0.1",
      size: 2,
      received_at: new Date(base + 1000 + i).toISOString(),
    }))
  );
  if (error) throw error;

  await openDashboard(page);
  // A method picked for HTTP must not hide every email once Email is chosen.
  await shown(page.getByRole("combobox", { name: "Method" })).selectOption("POST");
  const show = shown(page.getByRole("radiogroup", { name: "Show" }));
  await show.getByRole("radio", { name: /^Email/ }).click();

  await expect(shown(page.getByText("None in the newest requests"))).toBeVisible();
  await shown(page.getByRole("button", { name: "Load More" })).click();
  await expect(emailRow(page)).toBeVisible();

  await show.getByRole("radio", { name: /^All/ }).click();
  await expect(shown(page.getByRole("combobox", { name: "Method" }))).toHaveValue("ALL");
});
