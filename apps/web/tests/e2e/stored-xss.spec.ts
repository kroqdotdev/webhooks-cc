import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

const BODY_MARKER = "e2e-body-xss";
const BODY_SCRIPT_MARKER = "e2e-body-script-xss";
const HEADER_MARKER = "e2e-header-xss";
const QUERY_MARKER = "e2e-query-xss";
const REQUEST_PATH = "/xss-regression-check";
const HEADER_NAME = "x-xss-header";
const JSON_PATH = "/xss-json-check";
const JSON_KEY_MARKER = "e2e-json-key-xss";
const JSON_VALUE_MARKER = "e2e-json-value-xss";
const JSON_NESTED_MARKER = "e2e-json-nested-xss";
// Keys end up in generated TypeScript, Zod, Pydantic and JSON Schema source,
// which the Schema view highlights as HTML.
const JSON_PAYLOAD = JSON.stringify({
  [`<img src=x onerror="window.__xssHits.push('${JSON_KEY_MARKER}')">`]: `<script>window.__xssHits.push('${JSON_VALUE_MARKER}')</script>`,
  nested: {
    [`</code><svg onload="window.__xssHits.push('${JSON_NESTED_MARKER}')">`]: 1,
  },
});
const QUERY_NAME = "payload";

const BODY_PAYLOAD =
  `<img src=x onerror="window.__xssHits.push('${BODY_MARKER}')">` +
  `<script>window.__xssHits.push('${BODY_SCRIPT_MARKER}')</script>`;
const HEADER_PAYLOAD = `<svg onload="window.__xssHits.push('${HEADER_MARKER}')"></svg>`;
const QUERY_PAYLOAD = `<img src=x onerror="window.__xssHits.push('${QUERY_MARKER}')">`;

let testUser: TestUser;
let endpointId: string;
let endpointSlug: string;

async function createOwnedEndpoint(userId: string) {
  const slug = `xss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();

  const { data, error } = await admin
    .from("endpoints")
    .insert({
      user_id: userId,
      slug,
      name: "Stored XSS E2E Endpoint",
      is_ephemeral: false,
    })
    .select("id, slug")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function insertCapturedRequest(endpointIdValue: string, userId: string) {
  const { error } = await admin.from("requests").insert({
    endpoint_id: endpointIdValue,
    user_id: userId,
    method: "POST",
    path: REQUEST_PATH,
    headers: {
      "content-type": "text/html",
      [HEADER_NAME]: HEADER_PAYLOAD,
    },
    body: BODY_PAYLOAD,
    query_params: {
      [QUERY_NAME]: QUERY_PAYLOAD,
    },
    content_type: "text/html",
    ip: "127.0.0.1",
    size: BODY_PAYLOAD.length,
    received_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }
}

async function insertJsonRequest(endpointIdValue: string, userId: string) {
  // Older than the HTML request, so the dashboard still opens that one first.
  const { error } = await admin.from("requests").insert({
    endpoint_id: endpointIdValue,
    user_id: userId,
    method: "POST",
    path: JSON_PATH,
    headers: { "content-type": "application/json" },
    body: JSON_PAYLOAD,
    query_params: {},
    content_type: "application/json",
    ip: "127.0.0.1",
    size: JSON_PAYLOAD.length,
    received_at: new Date(Date.now() - 60_000).toISOString(),
  });

  if (error) {
    throw error;
  }
}

async function expectInertCode(page: Page, dialogs: string[]) {
  const code = page.locator("pre.syntax-highlight code").first();
  await expect(code).toBeVisible();
  await expect(code).toContainText("onerror");
  expect(await code.locator("img, script, svg").count()).toBe(0);
  const html = await code.innerHTML();
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<svg");
  await expectNoXssExecution(page, dialogs);
}

async function expectNoXssExecution(page: Page, dialogs: string[]) {
  const hits = await page.evaluate(() => {
    const win = window as Window & { __xssHits?: string[] };
    return Array.isArray(win.__xssHits) ? [...win.__xssHits] : [];
  });

  expect(hits).toEqual([]);
  expect(dialogs).toEqual([]);
}

test.beforeAll(async () => {
  testUser = await createTestUser();

  const endpoint = await createOwnedEndpoint(testUser.id);
  endpointId = endpoint.id;
  endpointSlug = endpoint.slug;

  await insertCapturedRequest(endpoint.id, testUser.id);
  await insertJsonRequest(endpoint.id, testUser.id);
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

test("dashboard renders hostile request payloads inertly", async ({ page }) => {
  const dialogs: string[] = [];

  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.addInitScript(() => {
    const win = window as Window & { __xssHits?: string[] };
    win.__xssHits = [];
  });

  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.getByRole("button", { name: /^body$/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(REQUEST_PATH).first()).toBeVisible({ timeout: 15_000 });

  await expectNoXssExecution(page, dialogs);

  await test.step("body tab keeps the hostile body inert", async () => {
    await page.getByRole("button", { name: /^body$/i }).click();

    const bodyCode = page.locator("code.language-markup").first();
    await expect(bodyCode).toBeVisible();
    await expect(bodyCode).toContainText(BODY_MARKER);
    await expect(bodyCode).toContainText(BODY_SCRIPT_MARKER);
    await expect(bodyCode).toContainText("onerror");

    expect(await bodyCode.locator("img, script, svg").count()).toBe(0);

    const highlightedHtml = await bodyCode.innerHTML();
    expect(highlightedHtml).not.toContain("<img");
    expect(highlightedHtml).not.toContain("<script");
    expect(highlightedHtml).not.toContain("<svg");

    await expectNoXssExecution(page, dialogs);
  });

  await test.step("headers tab keeps the hostile header inert", async () => {
    await page.getByRole("button", { name: /^headers$/i }).click();

    const headersTable = page.locator("table").first();
    await expect(headersTable).toBeVisible();
    await expect(headersTable).toContainText(HEADER_NAME);
    await expect(headersTable).toContainText(HEADER_MARKER);
    await expect(headersTable).toContainText("onload");

    expect(await headersTable.locator("img, script, svg").count()).toBe(0);

    const headersHtml = await headersTable.innerHTML();
    expect(headersHtml).not.toContain("<img");
    expect(headersHtml).not.toContain("<script");
    expect(headersHtml).not.toContain("<svg");

    await expectNoXssExecution(page, dialogs);
  });

  await test.step("query tab keeps the hostile query param inert", async () => {
    await page.getByRole("button", { name: /^query$/i }).click();

    const queryTable = page.locator("table").first();
    await expect(queryTable).toBeVisible();
    await expect(queryTable).toContainText(QUERY_NAME);
    await expect(queryTable).toContainText(QUERY_MARKER);
    await expect(queryTable).toContainText("onerror");

    expect(await queryTable.locator("img, script, svg").count()).toBe(0);

    const queryHtml = await queryTable.innerHTML();
    expect(queryHtml).not.toContain("<img");
    expect(queryHtml).not.toContain("<script");
    expect(queryHtml).not.toContain("<svg");

    await expectNoXssExecution(page, dialogs);
  });

  await test.step("raw tab keeps the hostile body inert", async () => {
    await page.getByRole("button", { name: /^raw$/i }).click();

    const rawBody = page.locator("pre.ui-code").first();
    await expect(rawBody).toBeVisible();
    await expect(rawBody).toContainText(BODY_MARKER);
    await expect(rawBody).toContainText(BODY_SCRIPT_MARKER);
    await expect(rawBody).toContainText("onerror");

    expect(await rawBody.locator("img, script, svg").count()).toBe(0);

    const rawHtml = await rawBody.innerHTML();
    expect(rawHtml).not.toContain("<img");
    expect(rawHtml).not.toContain("<script");
    expect(rawHtml).not.toContain("<svg");

    await expectNoXssExecution(page, dialogs);
  });
});

test("schema view keeps hostile JSON keys inert", async ({ page }) => {
  const dialogs: string[] = [];

  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  await page.addInitScript(() => {
    const win = window as Window & { __xssHits?: string[] };
    win.__xssHits = [];
  });

  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await page.getByText(JSON_PATH).first().click();
  await page.getByRole("button", { name: /^body$/i }).click();
  await page.getByRole("button", { name: "Schema", exact: true }).click();

  for (const format of ["TypeScript", "Zod", "Pydantic", "JSON Schema"]) {
    await test.step(`${format} schema stays inert`, async () => {
      await page.getByRole("radio", { name: format, exact: true }).click();
      await expectInertCode(page, dialogs);
    });
  }
});
