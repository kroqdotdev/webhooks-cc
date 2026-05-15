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

async function openSettings(page: import("@playwright/test").Page) {
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  // Wait for the URL bar to show the endpoint name
  await expect(page.locator("span.font-bold.uppercase", { hasText: "Rules E2E Test" })).toBeVisible(
    { timeout: 15000 }
  );
  // Click the settings gear button
  await page.getByLabel("Endpoint settings").click();
  // Wait for dialog to open
  await expect(page.getByRole("heading", { name: "Endpoint Settings" })).toBeVisible({
    timeout: 10000,
  });
}

test("settings dialog shows Response Rules section", async ({ page }) => {
  await openSettings(page);

  await expect(page.getByText("Response Rules")).toBeVisible();
  await expect(
    page.getByText("First matching rule wins. Falls back to the default mock response below.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Rule" })).toBeVisible();
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
  const ruleHeaders = page.locator("button.flex-1.text-left");
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

  // The response section should have a status picker and body textarea
  await expect(page.getByText("Response").first()).toBeVisible();

  // Set body text
  const bodyTextarea = page.locator("textarea").first();
  await bodyTextarea.fill('{"matched": true}');
  await expect(bodyTextarea).toHaveValue('{"matched": true}');
});

test("default mock response label updates when rules exist", async ({ page }) => {
  await openSettings(page);

  // Without rules, should say "Mock Response"
  await expect(page.getByText("Mock Response", { exact: true })).toBeVisible();

  // Add a rule
  await page.getByRole("button", { name: "Add Rule" }).click();

  // Should now say "Default Response" with fallback description
  await expect(page.getByText("Default Response", { exact: true })).toBeVisible();
  await expect(page.getByText("Returned when no rule matches.")).toBeVisible();
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

  // Set response body
  const bodyTextarea = page.locator("textarea").first();
  await bodyTextarea.fill('{"received": true}');

  // Save
  await page.getByRole("button", { name: "Save Changes" }).click();

  // Wait for dialog to close
  await expect(page.getByRole("heading", { name: "Endpoint Settings" })).not.toBeVisible({
    timeout: 5000,
  });

  // After save, emitDashboardEndpointsChanged triggers a GET /api/endpoints refetch.
  // Wait for that refetch to complete so the dialog will have fresh data when reopened.
  await page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/endpoints") &&
      resp.request().method() === "GET" &&
      resp.status() === 200,
    { timeout: 10000 }
  );

  // Small buffer for React to re-render with the new endpoint data
  await page.waitForTimeout(500);

  // Reopen settings
  await page.getByLabel("Endpoint settings").click();
  await expect(page.getByRole("heading", { name: "Endpoint Settings" })).toBeVisible({
    timeout: 10000,
  });

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
