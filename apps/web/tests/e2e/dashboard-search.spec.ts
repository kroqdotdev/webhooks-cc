import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * Search in the dashboard's request list. The server answers a search within
 * a time budget and says how far back it read, so the list never counts per
 * keystroke, drops the search a newer one replaced, goes on with "Search
 * older", and reads only the newer range when a request arrives.
 */

test.describe.configure({ mode: "serial" });

let user: TestUser;
let endpointSlug: string;

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
  endpointSlug = `e2e-search-${Date.now()}`;
  const { error } = await admin
    .from("endpoints")
    .insert({ slug: endpointSlug, name: "Search E2E", user_id: user.id });
  if (error) throw error;

  const start = Date.now() - 10 * 60_000;
  await captureRequest("/plain/1", new Date(start));
  await captureRequest("/needle/1", new Date(start + 1000));
  await captureRequest("/plain/2", new Date(start + 2000));
  await captureRequest("/needle/2", new Date(start + 3000));
  await captureRequest("/plain/3", new Date(start + 4000));
});

test.afterAll(async () => {
  if (user) {
    await admin.from("endpoints").delete().eq("user_id", user.id);
    await deleteTestUser(user.id);
  }
});

/** The dashboard renders the list for desktop and phones; only one shows. */
function shown(locator: Locator) {
  return locator.filter({ visible: true });
}
const rows = (page: Page) => shown(page.locator('[role="option"][data-request-id]'));
const searchBox = (page: Page) => shown(page.getByRole("textbox", { name: "Search requests" }));

/** The search and count calls the page makes, as URLs. */
function watchSearchCalls(page: Page) {
  const lists: URL[] = [];
  const counts: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/search/requests") lists.push(url);
    if (url.pathname === "/api/search/requests/count") counts.push(url);
  });
  return { lists, counts };
}

async function openDashboard(page: Page) {
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}`);
  await expect(rows(page).first()).toBeVisible({ timeout: 15000 });
}

test("a search lists its matches without counting, and adds a matching arrival", async ({
  page,
}) => {
  const calls = watchSearchCalls(page);
  await openDashboard(page);

  await searchBox(page).fill("needle");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText("/needle/2");
  // The count of what matched comes from the list: no count call names the term.
  expect(calls.counts.filter((url) => url.searchParams.has("q"))).toHaveLength(0);
  const searches = calls.lists.filter((url) => url.searchParams.get("q") === "needle");
  expect(searches).toHaveLength(1);

  // An arrival is searched for in the newer range only, and lands on top.
  await captureRequest("/plain/4", new Date());
  await captureRequest("/needle/3", new Date());
  await expect(rows(page)).toHaveCount(3, { timeout: 15000 });
  await expect(rows(page).first()).toContainText("/needle/3");
  const later = calls.lists
    .filter((url) => url.searchParams.get("q") === "needle")
    .slice(searches.length);
  expect(later.length).toBeGreaterThan(0);
  for (const url of later) expect(url.searchParams.get("from")).toMatch(/^\d+$/);

  // Signals are not replayed after sleep: coming back reads the newer range
  // once, and never the whole search again.
  const before = calls.lists.length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => calls.lists.length).toBeGreaterThan(before);
  await page.waitForLoadState("networkidle");
  for (const url of calls.lists.slice(before)) {
    if (url.searchParams.has("q")) expect(url.searchParams.get("from")).toMatch(/^\d+$/);
  }
  await expect(rows(page)).toHaveCount(3);
});

test("arrivals that could not all be read search the term again", async ({ page }) => {
  // The read of the newer range stops at its time budget, once.
  let cutShort = true;
  await page.route("**/api/search/requests?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") === "needle" && url.searchParams.has("from") && cutShort) {
      cutShort = false;
      return route.fulfill({
        json: [],
        headers: { "X-Search-Complete": "false", "X-Search-Searched-Until": String(Date.now()) },
      });
    }
    return route.fallback();
  });
  const calls = watchSearchCalls(page);
  await openDashboard(page);
  await searchBox(page).fill("needle");
  await expect(rows(page)).toHaveCount(3);

  await captureRequest("/needle/4", new Date());
  // The cut-short pass found nothing; the search run again from the top does.
  await expect(rows(page)).toHaveCount(4, { timeout: 15000 });
  await expect(rows(page).first()).toContainText("/needle/4");
  const full = calls.lists.filter(
    (url) => url.searchParams.get("q") === "needle" && !url.searchParams.has("from")
  );
  expect(full).toHaveLength(2);
});

test("a newer search aborts the one before it", async ({ page }) => {
  await page.route("**/api/search/requests?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") === "slow") {
      // Never answers in time: the next search has to cancel it.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      await route.abort().catch(() => {});
      return;
    }
    await route.fallback();
  });
  await openDashboard(page);

  const slow = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/search/requests" && url.searchParams.get("q") === "slow";
  });
  await searchBox(page).fill("slow");
  const slowRequest = await slow;
  const cancelled = page.waitForEvent("requestfailed", (request) => request === slowRequest);
  await searchBox(page).fill("needle");
  await cancelled;
  await expect(rows(page)).toHaveCount(4);
});

test("an unfinished search says how far it read and searches older on request", async ({
  page,
}) => {
  const searchedUntil = Date.now() - 3 * 86_400_000;
  let busyOnce = true;
  await page.route("**/api/search/requests?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") !== "rare") return route.fallback();
    if (url.searchParams.has("from")) {
      return route.fulfill({ json: [], headers: { "X-Search-Complete": "true" } });
    }
    if (!url.searchParams.has("cursor")) {
      // The time budget ran out before anything matched.
      return route.fulfill({
        json: [],
        headers: {
          "X-Search-Complete": "false",
          "X-Search-Searched-Until": String(searchedUntil),
          "X-Search-Cursor": "page-two",
        },
      });
    }
    expect(url.searchParams.get("cursor")).toBe("page-two");
    if (busyOnce) {
      busyOnce = false;
      return route.fulfill({
        status: 429,
        json: { error: "search_busy" },
        headers: { "Retry-After": "1" },
      });
    }
    // The older range holds the matches: answer with the real ones.
    url.searchParams.set("q", "needle");
    url.searchParams.delete("cursor");
    const real = await route.fetch({ url: url.toString() });
    return route.fulfill({
      json: await real.json(),
      headers: { "X-Search-Complete": "true" },
    });
  });
  await openDashboard(page);

  await searchBox(page).fill("rare");
  await expect(shown(page.getByText("No matches so far"))).toBeVisible();
  await expect(shown(page.getByText(/^Searched back to/))).toBeVisible();
  // A lower bound, for the eye and for a screen reader.
  await expect(shown(page.getByText(/^0\+/)).first()).toBeVisible();
  await expect(page.getByText("0 or more requests").first()).toBeAttached();

  const older = shown(page.getByRole("button", { name: "Search older" }));
  await older.click();
  await expect(shown(page.getByText(/Another search is still running/))).toBeVisible();
  await expect(older).toBeEnabled();

  await older.click();
  await expect(rows(page)).toHaveCount(4);
  // The whole range is read now: nothing more to search, and the count is exact.
  await expect(older).toHaveCount(0);
  await expect(shown(page.getByText(/^Searched back to/))).toHaveCount(0);
  await expect(page.getByText("4 requests").first()).toBeAttached();
});
