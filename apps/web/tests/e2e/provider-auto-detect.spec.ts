import { expect, test } from "@playwright/test";
import { buildTemplateSendOptions } from "@webhooks-cc/sdk";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

test.describe.configure({ mode: "serial" });

const TYPEFORM_SECRET = "typeform_e2e_secret";
const ENDPOINT_NAME = "Provider Detect E2E";
const REQUEST_PATH = "/typeform";

let testUser: TestUser;
let endpointId = "";
let endpointSlug = "";

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

  const { data: endpoint, error: endpointError } = await admin
    .from("endpoints")
    .insert({
      slug: `e2e-detect-${Date.now()}`,
      name: ENDPOINT_NAME,
      user_id: testUser.id,
      is_ephemeral: false,
    })
    .select("id, slug")
    .single();

  if (endpointError) throw endpointError;

  endpointId = endpoint.id;
  endpointSlug = endpoint.slug;

  const template = await buildTemplateSendOptions(`https://go.webhooks.cc/w/${endpointSlug}`, {
    provider: "typeform",
    template: "form_response",
    secret: TYPEFORM_SECRET,
  });
  const templateHeaders = template.headers ?? {};
  const templateBody = typeof template.body === "string" ? template.body : "";

  const { error: requestError } = await admin.from("requests").insert({
    endpoint_id: endpointId,
    user_id: testUser.id,
    method: template.method,
    path: REQUEST_PATH,
    headers: templateHeaders,
    body: templateBody,
    query_params: {},
    content_type: templateHeaders["content-type"] ?? "application/json",
    ip: "127.0.0.1",
    size: Buffer.byteLength(templateBody),
    received_at: new Date().toISOString(),
  });

  if (requestError) throw requestError;
});

test.afterAll(async () => {
  if (endpointId) {
    await admin.from("requests").delete().eq("endpoint_id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }

  if (testUser) {
    await deleteTestUser(testUser.id);
  }
});

test("dashboard shows detected provider, event, and preselects manual verification", async ({
  page,
}) => {
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);

  await expect(page.locator("span.font-bold.uppercase", { hasText: ENDPOINT_NAME })).toBeVisible({
    timeout: 15_000,
  });

  const requestRow = page.locator("button").filter({ hasText: REQUEST_PATH }).first();
  await expect(requestRow).toBeVisible({ timeout: 15_000 });
  await expect(requestRow.getByLabel("Detected provider: Typeform")).toBeVisible();
  await expect(requestRow).toContainText("form_response");

  await requestRow.click();

  await expect(page.getByLabel("Detected provider: Typeform").first()).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByText("form_response").first()).toBeVisible();

  await page.getByRole("button", { name: /^signature$/i }).click();

  await expect(page.locator("div").filter({ hasText: "Detected: Typeform" }).first()).toBeVisible();
  await expect(page.locator("#sig-provider").first()).toHaveValue("typeform");
  await expect(page.locator("#sig-secret").first()).toHaveAttribute(
    "placeholder",
    "your webhook secret"
  );
});
