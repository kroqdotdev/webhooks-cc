import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { encryptSigningSecret } from "@/lib/crypto";
import { DELIVER_PATH, signMailRequest } from "@/lib/test-email";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * The features every plan got in phase 1, in the dashboard: an endpoint's
 * retention, its alerts and replaying emails from an open alert, an email's
 * stored attachments and raw message, and the Google Sheets destination's
 * editor. Mail goes through the receiver's mail listener (MAIL_INGEST_URL),
 * so its objects are stored as in production; Google itself is stubbed.
 * Needs the receiver running with object storage, and
 * FORWARDING_ALLOW_PRIVATE_TARGETS=true for the local destination.
 */

test.describe.configure({ mode: "serial" });

const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const NAME = `Phase one ${ts}`;
let user: TestUser;
let endpointId: string;
let slug: string;
let token: string;
let server: Server;
let hookUrl: string;
const received: string[] = [];

async function sessionToken(): Promise<string> {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data, error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) throw error;
  return data.session!.access_token;
}

test.beforeAll(async ({ baseURL }) => {
  user = await createTestUser();
  await admin
    .from("users")
    .update({
      plan: "pro",
      request_limit: 100_000,
      requests_used: 0,
      period_end: new Date(Date.now() + 86_400_000).toISOString(),
    })
    .eq("id", user.id);
  const { data, error } = await admin
    .from("endpoints")
    .insert({ slug: `e2e-p1-${ts}`, name: NAME, user_id: user.id })
    .select("id, slug")
    .single();
  if (error) throw error;
  endpointId = data.id;
  slug = data.slug;
  token = await sessionToken();

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/orders`;
  const created = await fetch(`${baseURL}/api/endpoints/${slug}/destinations`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ url: hookUrl, name: "Orders hook", format: "json", email: true }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
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
  if (user) await deleteTestUser(user.id);
});

/** The dashboard renders the detail for desktop and mobile; only one is shown. */
function shown(locator: Locator) {
  return locator.filter({ visible: true });
}

async function openDashboard(page: Page) {
  await signInTestUser(page, user, `/dashboard?endpoint=${slug}`);
  await expect(page.locator("span.font-bold.caps", { hasText: NAME })).toBeVisible({
    timeout: 15000,
  });
}

async function showSettings(page: Page, section: string) {
  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Settings" })
    .click();
  const region = page.getByRole("region", { name: section });
  await expect(region).toBeVisible();
  return region;
}

async function openSettings(page: Page, section: string) {
  await openDashboard(page);
  return showSettings(page, section);
}

/** Delivers a message the way the MX host does, so the receiver stores its objects. */
/** Delivers an email through the mail listener; its request id and the message as sent. */
async function deliverMail(
  subject: string,
  attachment: string
): Promise<{ requestId: string; raw: string }> {
  const to = `${slug}@mailhooks.cc`;
  const raw = [
    "From: Acme Store <orders@acme.example>",
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="acme"',
    "",
    "--acme",
    "Content-Type: text/plain",
    "",
    "Your order is attached.",
    "--acme",
    "Content-Type: text/csv",
    'Content-Disposition: attachment; filename="order.csv"',
    "",
    attachment,
    "--acme--",
    "",
  ].join("\r\n");
  const body = JSON.stringify({
    recipients: [to],
    envelope_from: "orders@acme.example",
    client_ip: "203.0.113.7",
    client_rdns: null,
    helo: "mail.acme.example",
    tls: null,
    auth: null,
    spam: null,
    received_at: new Date().toISOString(),
    retry: false,
    raw: Buffer.from(raw).toString("base64"),
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(
    `${process.env.MAIL_INGEST_URL ?? "http://127.0.0.1:3002"}${DELIVER_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mail-timestamp": String(timestamp),
        "x-mail-signature": signMailRequest(
          process.env.CAPTURE_SHARED_SECRET!,
          timestamp,
          "POST",
          DELIVER_PATH,
          body
        ),
      },
      body,
    }
  );
  const result = (await response.json()) as {
    results: { status: string; request_id?: string }[];
  };
  expect(result.results[0].status).toBe("captured");
  return { requestId: result.results[0].request_id!, raw };
}

test("an endpoint keeps requests for fewer days, or until every destination has them", async ({
  page,
}) => {
  const retention = await openSettings(page, "Retention");
  await retention.getByRole("radio", { name: "Fewer days" }).click();
  await retention.getByLabel("Days to keep").fill("3");
  await retention.getByRole("button", { name: "Save changes" }).click();
  await expect(retention.getByText("Saved.")).toBeVisible({ timeout: 15000 });
  let row = (
    await admin
      .from("endpoints")
      .select("retention_days, delete_after_delivery")
      .eq("id", endpointId)
      .single()
  ).data;
  expect(row).toEqual({ retention_days: 3, delete_after_delivery: false });

  await retention.getByRole("radio", { name: "Deliver, then delete" }).click();
  await retention.getByRole("button", { name: "Save changes" }).click();
  await expect(retention.getByText("Saved.")).toBeVisible({ timeout: 15000 });
  row = (
    await admin
      .from("endpoints")
      .select("retention_days, delete_after_delivery")
      .eq("id", endpointId)
      .single()
  ).data;
  expect(row).toEqual({ retention_days: null, delete_after_delivery: true });

  // Back to the plan's retention, so the emails below stay.
  await retention.getByRole("radio", { name: /^\d+ days$/ }).click();
  await retention.getByRole("button", { name: "Save changes" }).click();
  await expect(retention.getByText("Saved.")).toBeVisible({ timeout: 15000 });
});

test("alerts are set up, and an open alert replays its emails", async ({ page }) => {
  const alerts = await openSettings(page, "Alerts");
  // The section loads its settings after it renders; switch on once that settled.
  const turnOn = async (name: string) => {
    const control = alerts.getByRole("switch", { name });
    await expect(async () => {
      if ((await control.getAttribute("aria-checked")) !== "true") await control.click();
      await expect(control).toHaveAttribute("aria-checked", "true", { timeout: 1000 });
    }).toPass({ timeout: 15000 });
  };
  await turnOn("Alerts");
  await alerts.getByLabel("Quiet for (hours)").fill("12");
  await turnOn("Failed deliveries");
  await alerts.getByRole("button", { name: "Save changes" }).click();
  await expect(alerts.getByText("Saved.")).toBeVisible({ timeout: 15000 });
  const { data: saved } = await admin
    .from("endpoint_alerts")
    .select("enabled, silence_hours, destination_failures")
    .eq("endpoint_id", endpointId)
    .single();
  expect(saved).toEqual({ enabled: true, silence_hours: 12, destination_failures: true });

  // An email arrives (and goes to the destination), then a fields alert opens.
  const { requestId } = await deliverMail(`Order replay ${ts}`, "sku,qty\r\nA-1,2");
  await expect.poll(() => received.length, { timeout: 20000 }).toBeGreaterThanOrEqual(1);
  const { error } = await admin.from("alert_events").insert({
    endpoint_id: endpointId,
    kind: "fields",
    details: { missing: ["order"] },
  });
  if (error) throw error;
  await page.reload();
  const reloaded = await showSettings(page, "Alerts");
  await expect(reloaded.getByText("Open", { exact: true })).toBeVisible({ timeout: 15000 });
  const before = received.length;
  await reloaded.getByRole("button", { name: "Replay these emails" }).click();
  await expect(reloaded.getByText(/Queued 1 of 1 emails to the destinations again\./)).toBeVisible({
    timeout: 15000,
  });
  await expect.poll(() => received.length, { timeout: 30000 }).toBeGreaterThan(before);
  expect(received.at(-1)).toContain(requestId);
});

test("an email's attachment and its exact message download from the dashboard", async ({
  page,
}) => {
  const subject = `Order attached ${ts}`;
  const { raw } = await deliverMail(subject, "sku,qty\r\nB-2,5");
  await openDashboard(page);
  await page.getByRole("button", { name: new RegExp(`EMAIL ${subject}`) }).click();
  await expect(shown(page.getByRole("heading", { name: subject }))).toBeVisible({
    timeout: 15000,
  });

  await shown(page.getByRole("button", { name: /^Attachments/ })).click();
  await expect(
    shown(page.getByText("Attachments are kept with the email and deleted with it."))
  ).toBeVisible();
  const attachment = page.waitForEvent("download");
  await shown(page.getByRole("button", { name: "Download order.csv" })).click();
  const file = await attachment;
  expect(file.suggestedFilename()).toBe("order.csv");
  const csv = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(csv).toString("utf8")).toBe("sku,qty\r\nB-2,5");

  await shown(page.getByRole("button", { name: /^Raw$/ })).click();
  await expect(shown(page.getByText(`Subject: ${subject}`))).toBeVisible();
  const eml = page.waitForEvent("download");
  await shown(page.getByRole("button", { name: "Download .eml" })).click();
  const message = await eml;
  expect(message.suggestedFilename()).toMatch(/^email-[0-9a-f]{8}\.eml$/);
  const bytes = Buffer.concat(await (await message.createReadStream()).toArray());
  // The message exactly as it arrived, headers and every MIME part.
  expect(bytes.toString("utf8")).toBe(raw);
});

test("a Google Sheets destination is set up with a new spreadsheet", async ({ page }) => {
  // A connected Google account, as the OAuth callback stores it; the calls
  // that would reach Google are stubbed.
  const { data: connection, error } = await admin
    .from("google_connections")
    .insert({
      user_id: user.id,
      google_sub: `e2e-${ts}`,
      google_email: "sheets@acme.example",
      refresh_token_encrypted: `\\x${encryptSigningSecret("e2e-refresh-token").toString("hex")}`,
      scopes: "https://www.googleapis.com/auth/drive.file",
    })
    .select("id")
    .single();
  if (error) throw error;
  const spreadsheetId = "1AcmeOrdersSheetE2eAbCdEfGhIjKlMnOpQrStUvW";
  let created: Record<string, unknown> | null = null;
  await page.route("**/api/integrations/google/spreadsheets", async (route) => {
    created = route.request().postDataJSON();
    await route.fulfill({ json: { id: spreadsheetId, headerWritten: true } });
  });

  const forwarding = await openSettings(page, "Forwarding");
  // The endpoint has a destination already: the kinds are one click away.
  await forwarding.getByRole("button", { name: "Add destination" }).click();
  await forwarding.getByRole("button", { name: /^Google Sheets/ }).click();
  await expect(forwarding.getByLabel("Google account")).toContainText("sheets@acme.example", {
    timeout: 15000,
  });
  await forwarding.getByLabel("New spreadsheet").fill("Acme orders");
  await forwarding.getByRole("button", { name: "Create it" }).click();
  await expect(forwarding.getByRole("link", { name: /Open the spreadsheet/ })).toHaveAttribute(
    "href",
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
  );
  expect(created).toMatchObject({ connectionId: connection.id, title: "Acme orders" });
  await forwarding.getByRole("button", { name: "Add destination" }).click();

  await expect
    .poll(
      async () =>
        (
          await admin
            .from("endpoint_destinations")
            .select("format, config")
            .eq("endpoint_id", endpointId)
            .eq("format", "sheets")
        ).data ?? [],
      { timeout: 15000 }
    )
    .toEqual([
      expect.objectContaining({
        format: "sheets",
        config: expect.objectContaining({ connectionId: connection.id, spreadsheetId }),
      }),
    ]);
});
