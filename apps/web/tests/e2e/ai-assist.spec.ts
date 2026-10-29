import { createServer, type Server } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * AI setup in the dashboard (lib/ai): draft a layout from picked emails and
 * find a field for it, with the consent box, the patterns tested on every
 * email, and the quota shown. Needs the dev server started with
 * ANTHROPIC_API_KEY and AI_API_BASE_URL=http://127.0.0.1:3199 (the fake
 * model this spec runs); skipped when the server does not offer AI setup.
 * The fake model listens on one fixed port, so the spec runs in one worker
 * (the chromium project) and covers the classic style itself.
 */

const FAKE_PORT = 3199;
let server: Server;
const users: TestUser[] = [];
const endpointIds: string[] = [];
const LAYOUT = {
  fields: [
    { name: "order", from: "subject", header: null, pattern: "Order #(\\d+)" },
    { name: "tracking", from: "text", header: null, pattern: "Tracking: (\\S+)" },
  ],
  match: { part: "subject", contains: "confirmed" },
  layoutName: "Acme orders",
};
const REPAIRED = {
  fields: [{ name: "order", from: "subject", header: null, pattern: "order (AC-\\d+)" }],
  match: null,
  layoutName: null,
};
const TOTAL = {
  fields: [{ name: "total", from: "text", header: null, pattern: "Total: \\$([0-9.]+)" }],
  match: null,
  layoutName: null,
};

test.describe.configure({ mode: "serial" });
// The fake model has one port: one worker (the chromium project) runs the spec.
const ONLY = "chromium";
// eslint-disable-next-line no-empty-pattern -- Playwright wants the fixtures destructured
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== ONLY, "runs in one worker; covers the classic style itself");
});

// eslint-disable-next-line no-empty-pattern -- Playwright wants the fixtures destructured
test.beforeAll(async ({}, testInfo) => {
  if (testInfo.project.name !== ONLY) return;
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      // The answer follows the ask, so any order of requests works.
      const proposal = raw.includes("no longer finds a value")
        ? REPAIRED
        : raw.includes('field named \\"total\\"')
          ? TOTAL
          : LAYOUT;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_e2e",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: JSON.stringify(proposal) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(FAKE_PORT, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  server?.close();
  for (const id of endpointIds) await admin.from("endpoints").delete().eq("id", id);
  for (const user of users) await deleteTestUser(user.id);
});

/** A Business account with an endpoint that has two order emails. */
async function setup(
  subjects = ["Order #1001 confirmed", "Order #1002 confirmed"]
): Promise<{ user: TestUser; endpointId: string; endpointSlug: string }> {
  const user = await createTestUser();
  users.push(user);
  await admin
    .from("users")
    .update({ plan: "business", subscription_status: "active" })
    .eq("id", user.id);
  const { data, error } = await admin
    .from("endpoints")
    .insert({ slug: `e2e-ai-${Date.now()}`, name: "AI E2E", user_id: user.id })
    .select("id, slug")
    .single();
  if (error) throw error;
  const endpointId = data.id;
  const endpointSlug = data.slug;
  endpointIds.push(endpointId);
  for (const [subject, total] of [
    [subjects[0], "12.50"],
    [subjects[1], "8.00"],
  ]) {
    const { error: captureError } = await admin.rpc("capture_webhook", {
      p_slug: endpointSlug,
      p_method: "EMAIL",
      p_path: `${endpointSlug}@mailhooks.cc`,
      p_headers: { subject },
      p_body: "raw",
      p_query_params: {},
      p_content_type: "message/rfc822",
      p_ip: "192.0.2.10",
      p_received_at: new Date().toISOString(),
      p_kind: "email",
      p_email: {
        subject,
        text: `Thanks for your order.\nTotal: $${total}\n`,
        from: [{ name: "Acme Store", address: "orders@acme.example" }],
      },
    });
    if (captureError) throw captureError;
  }
  return { user, endpointId, endpointSlug };
}

async function openSettings(page: Page, user: TestUser, endpointSlug: string) {
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.locator("span.font-bold.caps", { hasText: "AI E2E" })).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Settings" })
    .click();
}

async function openLayouts(page: Page, user: TestUser, endpointSlug: string) {
  await openSettings(page, user, endpointSlug);
  const section = page.getByRole("region", { name: "Layouts" });
  await expect(section).toBeVisible();
  return section;
}

async function draftAndFind(page: Page) {
  const { user, endpointId, endpointSlug } = await setup();
  const section = await openLayouts(page, user, endpointSlug);
  const draft = section.getByRole("button", { name: "Draft a layout with AI" });
  const offered = await draft.waitFor({ timeout: 15000 }).then(
    () => true,
    () => false
  );
  test.skip(!offered, "AI setup is not offered");
  await draft.click();

  const panel = section.getByRole("region", { name: "Draft a layout with AI" });
  await expect(panel.getByText("500 of 500 AI assists left this 30 days.")).toBeVisible();
  const propose = panel.getByRole("button", { name: "Propose" });
  // Nothing goes out before the consent box is ticked.
  await expect(propose).toBeDisabled();
  await panel.getByRole("checkbox", { name: /to Anthropic, our AI provider/ }).check();

  await propose.click();
  await expect(panel.getByText("Acme orders")).toBeVisible({ timeout: 15000 });
  await expect(panel.getByText("Order #(\\d+)")).toBeVisible();
  // The tracking pattern found nothing in these emails: not shown.
  await expect(panel.getByText("Tracking: (\\S+)")).toHaveCount(0);
  await expect(panel.getByText(/1 other proposal missed an email/)).toBeVisible();
  await panel.getByRole("button", { name: "Add this layout" }).click();

  // The new layout is open; find its total too.
  await section.getByRole("button", { name: "Find a field with AI" }).click();
  const fieldPanel = section.getByRole("region", { name: "Find a field with AI" });
  await fieldPanel.getByLabel("Field name").fill("total");
  await fieldPanel.getByLabel("What it is").fill("the order total");
  await fieldPanel.getByRole("checkbox", { name: /to Anthropic, our AI provider/ }).check();
  await fieldPanel.getByRole("button", { name: "Propose" }).click();
  await expect(fieldPanel.getByText("12.50")).toBeVisible({ timeout: 15000 });
  await fieldPanel.getByRole("button", { name: "Add field" }).click();
  await expect(fieldPanel.getByRole("button", { name: "Added" })).toBeVisible();

  await section.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("endpoints")
          .select("layouts")
          .eq("id", endpointId)
          .single();
        return data?.layouts;
      },
      { timeout: 10000 }
    )
    .toMatchObject([
      {
        name: "Acme orders",
        match: {
          conditions: [{ field: "email", name: "subject", op: "contains", value: "confirmed" }],
        },
        fields: [
          { name: "order", from: "subject", pattern: "Order #(\\d+)" },
          { name: "total", from: "text", pattern: "Total: \\$([0-9.]+)" },
        ],
      },
    ]);
}

test("draft a layout from emails, then find another field for it", async ({ page }) => {
  await draftAndFind(page);
});

test("the same in the classic style", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ui-style", "classic");
    localStorage.setItem("ui-style-source", "chosen");
  });
  await draftAndFind(page);
});

test("fix a field an open alert names, in the layout that has it", async ({ page }) => {
  // The sender changed its subjects; the order field no longer finds a value.
  const { user, endpointId, endpointSlug } = await setup([
    "Your order AC-7781 shipped",
    "Your order AC-7790 shipped",
  ]);
  const order = { name: "order", from: "subject", pattern: "Order #(\\d+)" };
  const layouts = [
    { id: "acme", name: "Acme orders", fields: [order] },
    { id: "other", name: "Other", fields: [{ ...order, pattern: "Ref (\\d+)" }] },
  ];
  await admin.from("endpoints").update({ layouts }).eq("id", endpointId);
  const { error } = await admin
    .from("alert_events")
    .insert({ endpoint_id: endpointId, kind: "fields", details: { missing: ["order"] } });
  if (error) throw error;

  await openSettings(page, user, endpointSlug);
  const alerts = page.getByRole("region", { name: "Alerts" });
  const fix = alerts.getByRole("button", { name: "Fix order with AI" });
  const offered = await fix.waitFor({ timeout: 15000 }).then(
    () => true,
    () => false
  );
  test.skip(!offered, "AI setup is not offered");
  await fix.click();

  const panel = alerts.getByRole("region", { name: "Fix order with AI" });
  await panel.getByRole("checkbox", { name: /to Anthropic, our AI provider/ }).check();
  await panel.getByRole("button", { name: "Propose" }).click();
  await expect(panel.getByText("AC-7781", { exact: true })).toBeVisible({ timeout: 15000 });
  await panel.getByRole("button", { name: "Use this pattern" }).click();
  await expect(
    alerts.getByText("Saved the new pattern for order.", { exact: false })
  ).toBeVisible();

  // Only the layout the field was found in changed.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("endpoints")
          .select("layouts")
          .eq("id", endpointId)
          .single();
        return (data?.layouts as { fields: { pattern: string }[] }[]).map(
          (layout) => layout.fields[0].pattern
        );
      },
      { timeout: 10000 }
    )
    .toEqual(["order (AC-\\d+)", "Ref (\\d+)"]);
});
