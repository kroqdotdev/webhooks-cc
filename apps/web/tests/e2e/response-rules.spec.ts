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

/** The "HTTP responses" card on the endpoint's Settings tab. */
function responsesSection(page: Page) {
  return page.getByRole("region", { name: "HTTP responses" });
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

test("settings tab shows the response rules", async ({ page }) => {
  await openSettings(page);

  const section = responsesSection(page);
  await expect(section.getByText("Response Rules")).toBeVisible();
  await expect(
    section.getByText(
      "The first matching rule wins. Without a match, the status code and body above are sent."
    )
  ).toBeVisible();
  await expect(section.getByRole("button", { name: "Add Rule" })).toBeVisible();
});

test("can add a rule with a condition", async ({ page }) => {
  await openSettings(page);

  // Click Add Rule
  await page.getByRole("button", { name: "Add Rule" }).click();

  // Rule card should appear
  await expect(page.getByText("Rule 1: 1 condition")).toBeVisible();

  // Default condition should be method = POST
  const fieldSelect = page.getByLabel("Condition field");
  await expect(fieldSelect).toHaveValue("method");
});

test("can change condition field and operator", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Add Rule" }).click();

  // Change field to "Header"
  const fieldSelect = page.getByLabel("Condition field");
  await fieldSelect.selectOption("header");

  // Operator should update to header-compatible ops
  const opSelect = page.getByLabel("Condition operator");
  await expect(opSelect).toHaveValue("exists");

  // Header name input should appear
  await expect(page.getByLabel("Header name")).toBeVisible();

  // Change op to "equals" — value input should appear
  await opSelect.selectOption("eq");
  await expect(page.getByLabel("Condition value")).toBeVisible();
});

test("can add multiple conditions to a rule", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Add Rule" }).click();

  // Add a second condition
  await page.getByRole("button", { name: "Add condition" }).click();

  // Should now show 2 condition rows (2 field selects)
  const fieldSelects = page.getByLabel("Condition field");
  await expect(fieldSelects).toHaveCount(2);

  // Remove buttons should appear (since there are >1 conditions)
  const removeButtons = page.getByLabel("Remove condition");
  await expect(removeButtons).toHaveCount(2);
});

test("can remove a condition", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Add Rule" }).click();
  await page.getByRole("button", { name: "Add condition" }).click();

  // Remove the first condition
  await page.getByLabel("Remove condition").first().click();

  // Should be back to 1 condition
  await expect(page.getByLabel("Condition field")).toHaveCount(1);
});

test("can add multiple rules", async ({ page }) => {
  await openSettings(page);

  await page.getByRole("button", { name: "Add Rule" }).click();
  await page.getByRole("button", { name: "Add Rule" }).click();

  // Should show 2 rule cards
  await expect(page.getByText("Rule 1: 1 condition")).toBeVisible();
  await expect(page.getByText("Rule 2: 1 condition")).toBeVisible();
});

test("can disable and delete a rule", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Add Rule" }).click();

  // Rule should be visible
  await expect(page.getByText("Rule 1: 1 condition")).toBeVisible();

  // Uncheck the enabled checkbox (the one inside the rule card header, labeled "Enabled")
  const enableCheckbox = page.getByRole("checkbox", { name: "Enabled" });
  await enableCheckbox.uncheck();

  // Delete the rule
  await page.getByLabel("Delete rule").click();

  // Rule should be gone
  await expect(page.getByText("Rule 1: 1 condition")).not.toBeVisible();
});

test("can reorder rules with move buttons", async ({ page }) => {
  await openSettings(page);

  // Add 2 rules with names
  await page.getByRole("button", { name: "Add Rule" }).click();
  await page.getByPlaceholder("Rule name (optional)").first().fill("First Rule");

  await page.getByRole("button", { name: "Add Rule" }).click();
  await page.getByPlaceholder("Rule name (optional)").last().fill("Second Rule");

  // Verify initial order
  const ruleHeaders = responsesSection(page).getByRole("button", { name: /^(Collapse|Expand) / });
  await expect(ruleHeaders.first()).toContainText("First Rule");
  await expect(ruleHeaders.last()).toContainText("Second Rule");

  // Move the first rule down
  await page.getByLabel("Move rule down").first().click();

  // Order should be swapped
  await expect(ruleHeaders.first()).toContainText("Second Rule");
  await expect(ruleHeaders.last()).toContainText("First Rule");
});

test("can set rule response status and body", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Add Rule" }).click();

  // The rule card has its own response, below the endpoint's default one
  await expect(responsesSection(page).getByText("Response", { exact: true })).toBeVisible();

  // Set body text
  const bodyTextarea = responsesSection(page).getByPlaceholder("Response body");
  await bodyTextarea.fill('{"matched": true}');
  await expect(bodyTextarea).toHaveValue('{"matched": true}');
});

test("save stays disabled until the responses change", async ({ page }) => {
  await openSettings(page);

  const section = responsesSection(page);
  const save = section.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();

  await section.getByRole("button", { name: "Add Rule" }).click();
  await expect(save).toBeEnabled();
  await expect(section.getByText("Response changed.")).toBeVisible();

  // Cancel puts the saved state back
  await section.getByRole("button", { name: "Cancel" }).click();
  await expect(save).toBeDisabled();
  await expect(page.getByText("Rule 1: 1 condition")).not.toBeVisible();
});

test("can save rules and they persist after reopening", async ({ page }) => {
  await openSettings(page);

  // Add a rule
  await page.getByRole("button", { name: "Add Rule" }).click();

  // Name the rule
  await page.getByPlaceholder("Rule name (optional)").fill("Persist Test");

  // Change condition to body_path with eq operator
  await page.getByLabel("Condition field").selectOption("body_path");
  await page.getByLabel("Condition operator").selectOption("eq");
  await page.getByLabel("JSON path").fill("type");
  await page.getByLabel("Condition value").fill("invoice.paid");

  // Set the rule's response body
  const section = responsesSection(page);
  await section.getByPlaceholder("Response body").fill('{"received": true}');

  // Save
  await section.getByRole("button", { name: "Save changes" }).click();
  await expect(section.getByText("Saved.")).toBeVisible({ timeout: 10000 });

  // Load the page again so the settings are read back from the database
  await page.reload();
  await openSettingsTab(page);

  // Rule should still be there (name shows in the rule card header)
  await expect(page.getByText("Persist Test")).toBeVisible({ timeout: 10000 });
});

test("saved rules work in the receiver", async ({ request }) => {
  // The previous test saved a rule: body_path "type" == "invoice.paid" -> {"received": true}
  // Verify the receiver evaluates it

  // Send a matching webhook
  const matchResponse = await request.post(`${WEBHOOK_URL}/w/${endpointSlug}`, {
    headers: { "Content-Type": "application/json" },
    data: { type: "invoice.paid" },
  });
  expect(matchResponse.status()).toBe(200);
  const matchBody = await matchResponse.json();
  expect(matchBody).toEqual({ received: true });

  // Send a non-matching webhook — should get default (200 OK since no default mock set)
  const noMatchResponse = await request.post(`${WEBHOOK_URL}/w/${endpointSlug}`, {
    headers: { "Content-Type": "application/json" },
    data: { type: "other.event" },
  });
  expect(noMatchResponse.status()).toBe(200);
});

// Depends on "can save rules and they persist after reopening" having saved "Persist Test" rule.
// Tests run serially (mode: "serial") so this state is guaranteed.
test("can collapse and expand a rule", async ({ page }) => {
  await openSettings(page);

  // Should see the persisted rule from the earlier save test
  await expect(page.getByText("Persist Test")).toBeVisible({ timeout: 5000 });

  // Click the rule header to collapse
  await page.getByText("Persist Test").click();

  // Condition builder should be hidden
  await expect(page.getByLabel("Condition field")).not.toBeVisible();

  // Click again to expand
  await page.getByText("Persist Test").click();
  await expect(page.getByLabel("Condition field")).toBeVisible();
});

test("logic toggle switches between AND and OR", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Add Rule" }).click();

  // Default should be AND — use last() since the persisted rule from earlier tests also has one
  const logicSelect = page.locator("select").filter({ hasText: "ALL conditions" }).last();
  await expect(logicSelect).toBeVisible();

  // Switch to OR
  await logicSelect.selectOption("or");
  await expect(page.locator("select").filter({ hasText: "ANY condition" }).last()).toBeVisible();
});
