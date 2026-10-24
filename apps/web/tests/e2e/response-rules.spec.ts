import { test, expect } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

// Tests must run serially — they share an endpoint with rules
test.describe.configure({ mode: "serial" });

let testUser: TestUser;
let endpointSlug: string;
let endpointId: string;
const WEBHOOK_URL = process.env.WHK_WEBHOOK_URL ?? "http://localhost:3001";

test.beforeAll(async () => {
  testUser = await createTestUser();

  // Make pro so we have generous quota
  await admin
    .from("users")
    .update({
      plan: "pro",
      request_limit: 10000,
      requests_used: 0,
      period_end: new Date(Date.now() + 86400000).toISOString(),
    })
    .eq("id", testUser.id);

  // Create an endpoint to work with
  const { data, error } = await admin
    .from("endpoints")
    .insert({
      slug: `e2e-rules-${Date.now()}`,
      name: "Rules E2E Test",
      user_id: testUser.id,
    })
    .select("id, slug")
    .single();
  if (error) throw error;
  endpointSlug = data.slug;
  endpointId = data.id;
});

test.afterAll(async () => {
  // Clean up endpoint + requests
  if (endpointId) {
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  if (testUser) {
    await deleteTestUser(testUser.id);
  }
});

type Page = import("@playwright/test").Page;

/** The "Responses" card on the endpoint's Settings tab. */
function responsesSection(page: Page) {
  return page.getByRole("region", { name: "Responses" });
}

async function openSettingsTab(page: Page) {
  // Wait for the endpoint bar to show the endpoint name
  await expect(page.locator("span.font-bold.caps", { hasText: "Rules E2E Test" })).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Settings" })
    .click();
  await expect(responsesSection(page)).toBeVisible({ timeout: 10000 });
}

async function openSettings(page: Page) {
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await openSettingsTab(page);
}

test("settings tab shows the responses in the order they are checked", async ({ page }) => {
  await openSettings(page);

  const section = responsesSection(page);
  const list = section.getByRole("list", { name: "Responses in the order they are checked" });
  await expect(list).toBeVisible();
  // Without rules, the default answers every request.
  await expect(list.getByRole("button", { name: /^Always/ })).toBeVisible();
  await expect(section.getByRole("button", { name: "Add rule" })).toBeVisible();
});

test("can add a rule with a condition", async ({ page }) => {
  await openSettings(page);
  const section = responsesSection(page);
  await section.getByRole("button", { name: "Add rule" }).click();

  await expect(section.getByRole("button", { name: /^Rule 1 When method is POST/ })).toBeVisible();
  await expect(section.getByRole("button", { name: /^Otherwise/ })).toBeVisible();
  await expect(section.getByLabel("Condition 1: what to check")).toHaveValue("method");
});

test("can change condition field and operator", async ({ page }) => {
  await openSettings(page);
  const section = responsesSection(page);
  await section.getByRole("button", { name: "Add rule" }).click();

  await section.getByLabel("Condition 1: what to check").selectOption("header");
  const op = section.getByLabel("Condition 1: how to compare");
  await expect(op).toHaveValue("exists");
  await expect(section.getByLabel("Condition 1: Header name")).toBeVisible();

  await op.selectOption("regex");
  await expect(section.getByLabel("Condition 1: value")).toBeVisible();
  await expect(section.getByText(/RE2 syntax/)).toBeVisible();
});

test("can add, combine and remove conditions", async ({ page }) => {
  await openSettings(page);
  const section = responsesSection(page);
  await section.getByRole("button", { name: "Add rule" }).click();
  await section.getByRole("button", { name: "Add condition" }).click();

  await expect(section.getByLabel(/^Condition \d: what to check$/)).toHaveCount(2);
  const logic = section.getByLabel("How the conditions combine");
  await expect(logic).toHaveValue("and");
  await logic.selectOption("or");
  await expect(logic).toHaveValue("or");

  await section.getByRole("button", { name: "Remove condition 1" }).click();
  await expect(section.getByLabel(/^Condition \d: what to check$/)).toHaveCount(1);
});

test("can switch off, reorder and delete rules", async ({ page }) => {
  await openSettings(page);
  const section = responsesSection(page);

  await section.getByRole("button", { name: "Add rule" }).click();
  await section.getByPlaceholder("Optional, for example Payment failed").first().fill("First");
  await section.getByRole("button", { name: "Add rule" }).click();
  await section.getByPlaceholder("Optional, for example Payment failed").last().fill("Second");

  await section.getByRole("switch", { name: "Rule 1 on" }).click();
  await expect(section.getByRole("button", { name: /^Rule 1 First \(off\)/ })).toBeVisible();

  await section.getByRole("button", { name: "Check later" }).first().click();
  await expect(section.getByRole("button", { name: /^Rule 1 Second/ })).toBeVisible();
  await expect(section.getByRole("button", { name: /^Rule 2 First/ })).toBeVisible();

  await section.getByRole("button", { name: "Delete rule" }).first().click();
  await expect(section.getByRole("button", { name: /^Rule 1 First/ })).toBeVisible();
  await expect(section.getByRole("button", { name: /^Rule 2/ })).toHaveCount(0);
});

test("save stays disabled until the responses change", async ({ page }) => {
  await openSettings(page);

  const section = responsesSection(page);
  const save = section.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();

  await section.getByRole("button", { name: "Add rule" }).click();
  await expect(save).toBeEnabled();
  await expect(section.getByText("Rules changed.")).toBeVisible();

  await section.getByRole("button", { name: "Cancel" }).click();
  await expect(save).toBeDisabled();
  await expect(section.getByRole("button", { name: /^Rule 1/ })).toHaveCount(0);
});

test("can save a rule with placeholders, and the preview shows it answering", async ({ page }) => {
  await openSettings(page);
  const section = responsesSection(page);

  await section.getByRole("button", { name: "Add rule" }).click();
  await section.getByPlaceholder("Optional, for example Payment failed").fill("Persist Test");
  await section.getByLabel("Condition 1: what to check").selectOption("body_path");
  await section.getByLabel("Condition 1: Field path").fill("type");
  await section.getByLabel("Condition 1: value").fill("invoice.paid");
  await section
    .getByLabel("Body")
    .first()
    .fill('{"received": "{{ json.type }}", "path": "{{ path }}"}');

  await section.getByRole("button", { name: "Save changes" }).click();
  await expect(section.getByText("Saved.")).toBeVisible({ timeout: 10000 });

  await page.reload();
  await openSettingsTab(page);
  await expect(
    responsesSection(page).getByRole("button", { name: /^Rule 1 Persist Test/ })
  ).toBeVisible({
    timeout: 10000,
  });
});

test("saved rules and placeholders work in the receiver", async ({ request }) => {
  // The previous test saved: body field type is invoice.paid -> {"received": "{{ json.type }}", ...}
  const matchResponse = await request.post(`${WEBHOOK_URL}/w/${endpointSlug}/billing`, {
    headers: { "Content-Type": "application/json" },
    data: { type: "invoice.paid" },
  });
  expect(matchResponse.status()).toBe(200);
  expect(await matchResponse.json()).toEqual({ received: "invoice.paid", path: "/billing" });

  // Not matching: the default (200 OK, no mock set)
  const noMatchResponse = await request.post(`${WEBHOOK_URL}/w/${endpointSlug}`, {
    headers: { "Content-Type": "application/json" },
    data: { type: "other.event" },
  });
  expect(noMatchResponse.status()).toBe(200);
  expect(await noMatchResponse.text()).toBe("OK");
});

// Depends on the saved "Persist Test" rule and the captured requests above.
test("the preview marks the rule that answers a captured request", async ({ page }) => {
  await openSettings(page);
  const section = responsesSection(page);
  const preview = section.getByLabel("Preview with");
  await expect(preview).toBeVisible();

  // The newest request is the non-matching one, so Otherwise answers.
  await expect(section.getByText("No rule matches, so Otherwise answers")).toBeVisible({
    timeout: 10000,
  });

  // Pick the matching request: Rule 1 answers, with its placeholders filled in.
  const options = await preview.locator("option").allTextContents();
  const billing = options.find((text) => text.includes("/billing"));
  expect(billing).toBeTruthy();
  await preview.selectOption({ label: billing! });
  await expect(section.getByText("Rule 1, Persist Test, answers")).toBeVisible({ timeout: 10000 });
  await expect(section.getByText('{"received": "invoice.paid", "path": "/billing"}')).toBeVisible();
});
