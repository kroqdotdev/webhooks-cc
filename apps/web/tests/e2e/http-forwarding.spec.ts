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
 * Forwarding HTTP requests end to end against a local server standing in
 * for the owner's: the Forwarding settings (format picked from the URL, a
 * header masked after saving, a test delivery), a captured request relayed
 * by the dev server's worker and its Deliveries tab with the journey (and a
 * Sent stop read from the body field the owner named), the delivery log with
 * its filters, a failed delivery sent again with "Redeliver all failed", and
 * a team member who can read deliveries but not redeliver. Needs the dev
 * server started with FORWARDING_ALLOW_PRIVATE_TARGETS=true (as in
 * .env.local) so it may post to 127.0.0.1.
 */

test.describe.configure({ mode: "serial" });

let owner: TestUser;
let member: TestUser;
let endpointSlug: string;
let endpointId: string;
let teamId: string;
let server: Server;
let hookUrl: string;
let answerWith = 200;
const received: { headers: IncomingHttpHeaders; body: string; url: string }[] = [];

test.beforeAll(async () => {
  owner = await createTestUser();
  member = await createTestUser();
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
    .insert({ slug: `e2e-http-fwd-${Date.now()}`, name: "HTTP forwarding E2E", user_id: owner.id })
    .select("id, slug")
    .single();
  if (error) throw error;
  endpointSlug = data.slug;
  endpointId = data.id;

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body, url: req.url ?? "" });
      res
        .writeHead(answerWith, { "content-type": "application/json" })
        .end(answerWith === 200 ? '{"received":true}' : '{"error":"try later"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/inbound`;
});

test.afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  if (teamId) await admin.from("teams").delete().eq("id", teamId);
  if (endpointId) {
    await admin.from("endpoints").update({ forward_enabled: false }).eq("id", endpointId);
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  if (owner) await deleteTestUser(owner.id);
  if (member) await deleteTestUser(member.id);
});

/** The dashboard renders the detail for desktop and mobile; only one is shown. */
function shown(locator: Locator) {
  return locator.filter({ visible: true });
}

async function openDashboard(page: Page, user: TestUser) {
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.locator("span.font-bold.caps", { hasText: "HTTP forwarding E2E" })).toBeVisible(
    { timeout: 15000 }
  );
}

async function openSettings(page: Page) {
  await openDashboard(page, owner);
  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Settings" })
    .click();
  const section = page.getByRole("region", { name: "Forwarding" });
  await expect(section).toBeVisible();
  return section;
}

async function saveSection(section: Locator) {
  await section.getByRole("button", { name: "Save changes" }).click();
  await expect(section.getByText("Saved.")).toBeVisible({ timeout: 10000 });
}

/** Captures an HTTP request the way the receiver does, through the stored procedure. */
async function captureRequest(path: string, body: Record<string, unknown>) {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: endpointSlug,
    p_method: "POST",
    p_path: path,
    p_headers: { "content-type": "application/json", "user-agent": "e2e-sender/1.0" },
    p_body: JSON.stringify(body),
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
    p_kind: "http",
    p_email: null,
    p_dedupe_key: null,
    p_retry: false,
    p_size: null,
  });
  if (error) throw error;
  return (data as { request_id: string }).request_id;
}

test("set up forwarding to a server: format from the URL, a masked header, a test delivery", async ({
  page,
}) => {
  const section = await openSettings(page);

  // The switch waits for a saved URL.
  const toggle = section.getByRole("switch", { name: "Forward captured requests" });
  await expect(toggle).toBeDisabled();
  await section.getByLabel("Send to").fill(hookUrl);
  await expect(section.getByText("URL changed.")).toBeVisible();
  await section.getByLabel("HTTP requests").check();
  await section.getByLabel("Emails").uncheck();
  await expect(section.getByText("URL and what to forward changed.")).toBeVisible();

  // A server URL picks "As received", and says so.
  const format = section.getByRole("radiogroup", { name: "Format" });
  await expect(format.getByRole("radio", { name: "As received" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await expect(section.getByText("Picked from the URL: a server URL")).toBeVisible();
  await expect(section.getByText("Five headers on every as-received delivery")).toBeVisible();
  await expect(section.getByText("webhooks-cc-attempt")).toBeVisible();

  // A header, typed once and masked after saving.
  await section.getByRole("button", { name: "Add header" }).click();
  await expect(section.getByLabel("Header 1 name")).toBeFocused();
  await section.getByLabel("Header 1 name").fill("Authorization");
  await section.getByLabel("Header 1 value").fill("Bearer e2e-secret-token-9876");
  await expect(section.getByText("Forwarding changed.")).toBeVisible();
  await saveSection(section);
  await expect(section.getByLabel("Header 1 value, hidden after saving")).toHaveValue(
    "Bearer ••••9876"
  );
  await expect(section.getByRole("button", { name: "Replace" })).toBeVisible();
  await expect(toggle).toBeEnabled();

  // The secret exists before forwarding is on.
  await section.getByRole("button", { name: "Reveal" }).click();
  await expect(section.locator("code", { hasText: /^whsec_/ })).toHaveText(
    /^whsec_[A-Za-z0-9+/]{32}$/
  );

  // A test delivery: nothing captured yet, so a sample, relayed with the header.
  await section.getByRole("button", { name: "Send test delivery" }).click();
  await expect(
    section.getByText(/^Delivered\. Your server answered 200 in \d+ ms\. A sample request/)
  ).toBeVisible({ timeout: 20000 });
  const sample = received.at(-1)!;
  expect(sample.headers.authorization).toBe("Bearer e2e-secret-token-9876");
  expect(sample.headers["webhooks-cc-endpoint"]).toBe(endpointSlug);
  expect(sample.headers["webhooks-cc-signature"]).toMatch(/^v1,/);

  // The sent time field, then on.
  await section.getByText("Advanced", { exact: true }).click();
  await section.getByLabel("Sent time field").fill("publishedAt");
  await expect(section.getByText("sent time from publishedAt")).toBeVisible();
  await toggle.click();
  await expect(section.getByText("Forwarding changed.")).toBeVisible();
  await saveSection(section);
  await expect(
    section.getByText("On. Every HTTP request captured here is sent to the URL below.")
  ).toBeVisible();
  const { data } = await admin
    .from("endpoints")
    .select("forward_enabled, forward_url, forward_http, forward_email, forward_sent_field")
    .eq("id", endpointId)
    .single();
  expect(data).toEqual({
    forward_enabled: true,
    forward_url: hookUrl,
    forward_http: true,
    forward_email: false,
    forward_sent_field: "publishedAt",
  });
});

test("a captured request is relayed and its Deliveries tab shows the journey", async ({ page }) => {
  const before = received.length;
  const publishedAt = new Date(Date.now() - 250).toISOString();
  const requestId = await captureRequest("/orders/events", {
    event: "order.shipped",
    publishedAt,
  });

  // The dev server's worker relays it within a few seconds, path appended.
  await expect.poll(() => received.length, { timeout: 20000 }).toBeGreaterThan(before);
  const relayed = received.at(-1)!;
  expect(relayed.url).toBe("/hooks/inbound/orders/events");
  expect(JSON.parse(relayed.body)).toEqual({ event: "order.shipped", publishedAt });
  expect(relayed.headers["webhooks-cc-request-id"]).toBe(requestId);
  expect(relayed.headers.authorization).toBe("Bearer e2e-secret-token-9876");

  await openDashboard(page, owner);
  await page.getByRole("button", { name: /^POST \/orders\/events/ }).click();
  await shown(page.getByRole("button", { name: /^deliveries$/i })).click();
  await expect(shown(page.getByText(/^Forwarded as received to /))).toBeVisible({
    timeout: 15000,
  });
  await expect(shown(page.getByText("/hooks/inbound/orders/events"))).toBeVisible();
  const journey = shown(page.getByRole("img", { name: /Sent at .* according to publishedAt/ }));
  await expect(journey).toBeVisible();
  await expect(journey).toHaveAccessibleName(/Received at .*, delivered .* later at/);
  await expect(shown(page.getByText("from publishedAt"))).toBeVisible();
  await expect(shown(page.getByRole("region", { name: "Delivery" }))).toContainText("Delivered");
  await expect(shown(page.getByText("1 try"))).toBeVisible();

  // UTC is remembered.
  await shown(page.getByRole("button", { name: "Local time. Show UTC" })).click();
  await expect(
    shown(page.getByText(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/).first())
  ).toBeVisible();
  await page.reload();
  await shown(page.getByRole("button", { name: /^deliveries$/i })).click();
  await expect(shown(page.getByRole("button", { name: "UTC. Show local time" }))).toBeVisible();
  await shown(page.getByRole("button", { name: "UTC. Show local time" })).click();
});

test("the delivery log lists it, with live counts, and opens the request", async ({ page }) => {
  await openSettings(page);
  const log = page.getByRole("region", { name: "Deliveries" });
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Deliveries" })
    .click();
  await expect(log).toBeVisible();
  const row = log.getByRole("row", { name: "Open the deliveries of POST /orders/events" });
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row).toContainText("Delivered");
  await expect(row).toContainText("200");
  await expect(log.getByRole("columnheader", { name: "Sent to received" })).toBeVisible();
  await expect(row.getByTitle("From the sender's own timestamp to our receipt")).toHaveText(
    /^\d+ ms$/
  );
  const filters = log.getByRole("radiogroup", { name: "Show" });
  await expect(filters.getByRole("radio", { name: /^Retrying 0$/ })).toBeVisible();
  await expect(filters.getByRole("radio", { name: /^Failed 0$/ })).toBeVisible();

  // The health line in Forwarding counts it too.
  const section = page.getByRole("region", { name: "Forwarding" });
  await expect(section.getByText("1 delivered")).toBeVisible({ timeout: 10000 });

  // Enter on the row opens the request's Deliveries tab.
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(shown(page.getByText(/^Forwarded as received to /))).toBeVisible({
    timeout: 15000,
  });
  await expect(page).toHaveURL(/tab=deliveries/);
});

test("a failed delivery is sent again with Redeliver all failed", async ({ page }) => {
  // Retries off, so one 503 marks the delivery failed at once.
  const section = await openSettings(page);
  await section.getByText("Advanced", { exact: true }).click();
  await section
    .getByRole("radiogroup", { name: "Retry failed deliveries" })
    .getByRole("radio", { name: "Never" })
    .click();
  await expect(section.getByText("never retried")).toBeVisible();
  await saveSection(section);

  answerWith = 503;
  const before = received.length;
  await captureRequest("/orders/events", { event: "order.cancelled" });
  await expect.poll(() => received.length, { timeout: 20000 }).toBeGreaterThan(before);
  await expect
    .poll(
      async () => {
        const { count } = await admin
          .from("email_deliveries")
          .select("id", { count: "exact", head: true })
          .eq("endpoint_id", endpointId)
          .eq("status", "failed");
        return count;
      },
      { timeout: 20000 }
    )
    .toBe(1);
  answerWith = 200;

  const log = page.getByRole("region", { name: "Deliveries" });
  const filters = log.getByRole("radiogroup", { name: "Show" });
  await expect(filters.getByRole("radio", { name: /^Failed 1$/ })).toBeVisible({ timeout: 15000 });
  await filters.getByRole("radio", { name: /^Failed 1$/ }).click();
  const failedRow = log.getByRole("row", { name: "Open the deliveries of POST /orders/events" });
  await expect(failedRow).toContainText("Failed");
  await expect(failedRow).toContainText("503");
  await expect(failedRow).toContainText("after 1 try");

  await log.getByRole("button", { name: "Redeliver all failed" }).click();
  await expect(
    log.getByText("Send the 1 failed delivery again with the current URL, format and headers?")
  ).toBeVisible();
  const beforeRedelivery = received.length;
  await log.getByRole("button", { name: "Send them again" }).click();
  await expect(log.getByText("Queued 1. They go out oldest first.")).toBeVisible({
    timeout: 10000,
  });
  await expect.poll(() => received.length, { timeout: 20000 }).toBeGreaterThan(beforeRedelivery);
  // The failed delivery stays in the log; the new one is delivered.
  await filters.getByRole("radio", { name: /^All$/ }).click();
  await expect(
    log.getByRole("row", { name: "Open the deliveries of POST /orders/events" }).first()
  ).toContainText("Delivered", { timeout: 15000 });
  await expect(filters.getByRole("radio", { name: /^Retrying 0$/ })).toBeVisible({
    timeout: 15000,
  });
  await expect(section.getByText("1 failed")).toBeVisible();
});

test("a team member reads deliveries but cannot redeliver", async ({ page }) => {
  // Team access hangs off the team's subscription; written as the Polar webhook would.
  const { data: team, error } = await admin
    .from("teams")
    .insert({
      name: "Forwarding E2E team",
      created_by: owner.id,
      subscription_status: "active",
      seats: 2,
      requests_used: 0,
      request_limit: 200_000,
      period_start: new Date().toISOString(),
      period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      cancel_at_period_end: false,
    })
    .select("id")
    .single();
  if (error) throw error;
  teamId = team.id;
  await admin.from("team_members").insert([
    { team_id: teamId, user_id: owner.id, role: "owner" },
    { team_id: teamId, user_id: member.id, role: "member" },
  ]);
  await admin
    .from("team_endpoints")
    .insert({ team_id: teamId, endpoint_id: endpointId, shared_by: owner.id });

  await openDashboard(page, member);
  await page
    .getByRole("button", { name: /^POST \/orders\/events/ })
    .first()
    .click();
  await shown(page.getByRole("button", { name: /^deliveries$/i })).click();
  await expect(shown(page.getByText(/^Forwarded as received to /))).toBeVisible({
    timeout: 15000,
  });
  await expect(
    shown(page.getByRole("region", { name: /^(Delivery|Redelivery)$/ })).first()
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Redeliver" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deliver now" })).toHaveCount(0);
  // The path of the owner's URL stays private: the host alone is named.
  await expect(shown(page.getByText("/hooks/inbound/orders/events"))).toHaveCount(0);
});
