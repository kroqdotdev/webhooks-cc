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
let otherSlug: string;
let otherNewestId: string;

/** Captures an HTTP request the way the receiver does, through the stored procedure. */
async function captureRequest(
  path: string,
  receivedAt: Date,
  slug = endpointSlug
): Promise<string> {
  const { data, error } = await admin.rpc("capture_webhook", {
    p_slug: slug,
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

  // A second endpoint to switch to, with requests of its own.
  otherSlug = `e2e-deep-other-${Date.now()}`;
  const { error: otherError } = await admin
    .from("endpoints")
    .insert({ slug: otherSlug, name: "Deep link other E2E", user_id: user.id });
  if (otherError) throw otherError;
  await captureRequest("/other/1", new Date(Date.now() - 5 * 60_000), otherSlug);
  otherNewestId = await captureRequest("/other/2", new Date(Date.now() - 4 * 60_000), otherSlug);

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

test("Back and Forward between endpoints select each one's own request", async ({ page }) => {
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}`);
  await expect(row(page, newestId)).toBeVisible({ timeout: 15000 });
  await row(page, middleId).click();
  await expect.poll(() => requestOf(page)).toBe(middleId);

  // The other endpoint must never ask for one of this endpoint's requests.
  const lookups: string[] = [];
  page.on("request", (request) => {
    const match = /\/api\/requests\/([0-9a-f-]{36})$/.exec(new URL(request.url()).pathname);
    if (match && request.method() === "GET") lookups.push(match[1]);
  });

  await page.getByRole("combobox", { name: "Endpoint" }).click();
  await page.getByRole("option", { name: "Deep link other E2E" }).click();
  await expect(row(page, otherNewestId)).toHaveAttribute("aria-selected", "true", {
    timeout: 15000,
  });

  await page.goBack();
  await expect(row(page, middleId)).toHaveAttribute("aria-selected", "true", { timeout: 15000 });
  await expect(shown(page.getByText('"/orders/20"'))).toBeVisible();

  await page.goForward();
  await expect(row(page, otherNewestId)).toHaveAttribute("aria-selected", "true", {
    timeout: 15000,
  });
  await expect(shown(page.getByText('"/other/2"'))).toBeVisible();
  expect(lookups).toEqual([]);
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

  test("a link to a request that is not there shows the list, not another request", async ({
    page,
  }) => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}&request=${missing}`);
    await expect(row(page, newestId)).toBeVisible({ timeout: 15000 });
    await expect(backToList(page)).toBeHidden();
    await expect.poll(() => requestOf(page)).toBeNull();
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

// Last: it adds a request, which the tests above would see as the newest.
test("following live requests selects the newest and names no request in the address", async ({
  page,
}) => {
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}&request=${middleId}`);
  await expect(row(page, middleId)).toHaveAttribute("aria-selected", "true", { timeout: 15000 });

  const first = await captureRequest("/orders/live-1", new Date());
  await expect(row(page, first)).toHaveAttribute("aria-selected", "true", { timeout: 15000 });
  // "The newest" is an address without ?request=: a reload opens the newest again.
  await expect.poll(() => requestOf(page)).toBeNull();

  // Later arrivals are followed without another write to the address. (Next
  // mirrors the write above with one of its own a moment later; let it pass.)
  await page.waitForTimeout(1500);
  const writes = await page.evaluate(() => {
    const counter = { count: 0 };
    const original = history.replaceState.bind(history);
    history.replaceState = (...args) => {
      counter.count++;
      return original(...args);
    };
    (window as unknown as { __writes: typeof counter }).__writes = counter;
    return counter.count;
  });
  expect(writes).toBe(0);
  const second = await captureRequest("/orders/live-2", new Date());
  await expect(row(page, second)).toHaveAttribute("aria-selected", "true", { timeout: 15000 });
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(() => (window as unknown as { __writes: { count: number } }).__writes.count)
  ).toBe(0);
  expect(requestOf(page)).toBeNull();
});

test("a request arriving while a navigation is on its way does not cancel it", async ({ page }) => {
  // The address names a request, so following the arrival wants to rewrite it.
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}&request=${middleId}`);
  await expect(row(page, middleId)).toHaveAttribute("aria-selected", "true", { timeout: 15000 });

  // Hold the Account page back, so the arrival lands while the router waits for it.
  let held = 0;
  await page.route(
    (url) => url.pathname === "/account",
    async (route) => {
      held++;
      await new Promise((done) => setTimeout(done, 3000));
      await route.continue();
    }
  );
  await page
    .getByRole("banner")
    .getByRole("button", { name: /E2E Test User/ })
    .click();
  await page.getByRole("menuitem", { name: "Account" }).click();
  await expect.poll(() => held).toBeGreaterThan(0);

  const arrived = await captureRequest("/orders/during-navigation", new Date());
  await expect(row(page, arrived)).toHaveAttribute("aria-selected", "true", { timeout: 15000 });
  // The address is left alone while the navigation is pending...
  await page.waitForTimeout(600);
  expect(requestOf(page)).toBe(middleId);
  // ...and the navigation lands.
  await expect(page).toHaveURL(/\/account$/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  // Nothing from the dashboard writes the address afterwards.
  await page.waitForTimeout(1000);
  expect(new URL(page.url()).pathname).toBe("/account");
  expect(new URL(page.url()).search).toBe("");
});
