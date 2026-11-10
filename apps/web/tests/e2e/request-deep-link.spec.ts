import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * A request's own link: ?request= opens that request once the dashboard has
 * loaded, whether the first page of the list holds it or it is older than
 * that, and a link to a request that is not there falls back to the newest.
 * At phone width the detail replaces the list, and both the "Back to list"
 * button and the browser's Back return to the list.
 */

test.describe.configure({ mode: "serial" });

/** The first page of the list holds this many requests (app/dashboard/page.tsx). */
const PAGE_SIZE = 50;

let user: TestUser;
let endpointSlug: string;
let oldestId: string;
let middleId: string;
let newestId: string;

/** Captures an HTTP request the way the receiver does, through the stored procedure. */
async function captureRequest(path: string, receivedAt: Date): Promise<string> {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: endpointSlug,
    p_method: "POST",
    p_path: path,
    p_headers: { "content-type": "application/json" },
    p_body: JSON.stringify({ path }),
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "192.0.2.10",
    p_received_at: receivedAt.toISOString(),
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

test.beforeAll(async () => {
  user = await createTestUser();
  await admin
    .from("users")
    .update({
      plan: "pro",
      request_limit: 10000,
      requests_used: 0,
      period_end: new Date(Date.now() + 86_400_000).toISOString(),
    })
    .eq("id", user.id);
  endpointSlug = `e2e-deep-link-${Date.now()}`;
  const { error } = await admin
    .from("endpoints")
    .insert({ slug: endpointSlug, name: "Deep link E2E", user_id: user.id });
  if (error) throw error;

  // One request older than the first page, then a full page after it.
  const start = Date.now() - 10 * 60_000;
  oldestId = await captureRequest("/oldest-order", new Date(start));
  for (let i = 1; i <= PAGE_SIZE; i++) {
    const id = await captureRequest(`/orders/${i}`, new Date(start + i * 1000));
    if (i === 20) middleId = id;
    if (i === PAGE_SIZE) newestId = id;
  }
});

test.afterAll(async () => {
  if (user) {
    await admin.from("endpoints").delete().eq("user_id", user.id);
    await deleteTestUser(user.id);
  }
});

/** The dashboard renders the list and the detail for desktop and phones; only one shows. */
function shown(locator: Locator) {
  return locator.filter({ visible: true });
}

const row = (page: Page, id: string) =>
  shown(page.locator(`[role="option"][data-request-id="${id}"]`));
const requestOf = (page: Page) => new URL(page.url()).searchParams.get("request");

test("a link to a request on the first page opens it instead of the newest", async ({ page }) => {
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}&request=${middleId}`);
  await expect(row(page, middleId)).toHaveAttribute("aria-selected", "true", { timeout: 15000 });
  await expect(row(page, newestId)).toHaveAttribute("aria-selected", "false");
  await expect(shown(page.getByText('"/orders/20"'))).toBeVisible();
  expect(requestOf(page)).toBe(middleId);
});

test("a link to a request older than the first page fetches and opens it", async ({ page }) => {
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}&request=${oldestId}`);
  // The list has not loaded it; the detail shows it all the same.
  await expect(row(page, newestId)).toBeVisible({ timeout: 15000 });
  await expect(row(page, oldestId)).toHaveCount(0);
  await expect(shown(page.getByText('"/oldest-order"'))).toBeVisible({ timeout: 15000 });
  await expect(row(page, newestId)).toHaveAttribute("aria-selected", "false");
  expect(requestOf(page)).toBe(oldestId);
});

test("a link to a request that is not there opens the newest", async ({ page }) => {
  const missing = "00000000-0000-4000-8000-000000000000";
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}&request=${missing}`);
  await expect(row(page, newestId)).toHaveAttribute("aria-selected", "true", { timeout: 15000 });
  await expect.poll(() => requestOf(page)).toBeNull();
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const backToList = (page: Page) => page.getByRole("button", { name: /Back to list/ });

  test("Back to list and the browser's Back return from a request to the list", async ({
    page,
  }) => {
    await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}`);
    await expect(row(page, newestId)).toBeVisible({ timeout: 15000 });
    await expect(backToList(page)).toBeHidden();

    // The button.
    await row(page, middleId).click();
    await expect(backToList(page)).toBeVisible();
    await expect(shown(page.getByText('"/orders/20"'))).toBeVisible();
    await expect.poll(() => requestOf(page)).toBe(middleId);
    await backToList(page).click();
    await expect(backToList(page)).toBeHidden();
    await expect(row(page, middleId)).toBeVisible();
    await expect.poll(() => requestOf(page)).toBeNull();

    // The browser's Back: the list again, still on the dashboard.
    await row(page, newestId).click();
    await expect(backToList(page)).toBeVisible();
    await expect.poll(() => requestOf(page)).toBe(newestId);
    await page.goBack();
    await expect(backToList(page)).toBeHidden();
    await expect(row(page, newestId)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/dashboard");
    expect(requestOf(page)).toBeNull();
  });

  test("a request's link opens its detail, and Back to list shows the list", async ({ page }) => {
    await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}&request=${oldestId}`);
    await expect(backToList(page)).toBeVisible({ timeout: 15000 });
    await expect(shown(page.getByText('"/oldest-order"'))).toBeVisible();
    await backToList(page).click();
    await expect(row(page, newestId)).toBeVisible();
    await expect.poll(() => requestOf(page)).toBeNull();
  });
});
