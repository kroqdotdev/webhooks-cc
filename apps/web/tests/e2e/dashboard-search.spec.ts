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
  const { data: endpoint, error } = await admin
    .from("endpoints")
    .insert({ slug: endpointSlug, name: "Search E2E", user_id: user.id })
    .select("id")
    .single();
  if (error) throw error;

  // More than a page of older requests, so the list has a "Load More".
  const bulkStart = Date.now() - 60 * 60_000;
  const { error: bulkError } = await admin.from("requests").insert(
    Array.from({ length: 60 }, (_, i) => ({
      endpoint_id: endpoint.id,
      user_id: user.id,
      method: "POST",
      path: `/bulk/${i}`,
      headers: { "content-type": "application/json" },
      body: "{}",
      query_params: {},
      content_type: "application/json",
      ip: "192.0.2.10",
      size: 2,
      received_at: new Date(bulkStart + i * 1000).toISOString(),
    }))
  );
  if (bulkError) throw bulkError;

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
  // Busy answers left to give: the page tries a busy search once more by
  // itself, so it takes two for the person to hear about it.
  let busyLeft = 2;
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
    if (busyLeft > 0) {
      busyLeft--;
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

/** Answers a mocked search with the real matches for "needle". */
async function needleRows(route: Parameters<Parameters<Page["route"]>[1]>[0]) {
  const url = new URL(route.request().url());
  for (const key of ["cursor", "from"]) url.searchParams.delete(key);
  url.searchParams.set("q", "needle");
  url.searchParams.set("limit", "50");
  const real = await route.fetch({ url: url.toString() });
  return (await real.json()) as unknown[];
}
const incomplete = (searchedUntil: number, cursor?: string) => ({
  "X-Search-Complete": "false",
  "X-Search-Searched-Until": String(searchedUntil),
  ...(cursor ? { "X-Search-Cursor": cursor } : {}),
});

test("arrivals that could not all be read keep the pages Search older loaded", async ({ page }) => {
  const day = 86_400_000;
  const firstPages: URL[] = [];
  const continued: string[] = [];
  await page.route("**/api/search/requests?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") !== "rare") return route.fallback();
    const cursor = url.searchParams.get("cursor");
    if (url.searchParams.has("from")) {
      // The read of the newer range runs out of time.
      return route.fulfill({ json: [], headers: incomplete(Date.now()) });
    }
    if (cursor) {
      continued.push(cursor);
      // "Search older" finds the matches and could go further back.
      return route.fulfill({
        json: cursor === "page-two" ? await needleRows(route) : [],
        headers: incomplete(Date.now() - 5 * day, "page-three"),
      });
    }
    firstPages.push(url);
    return route.fulfill({
      json: [],
      // The first read, and the read of the top again after the arrival: both
      // reach back past everything that was newer.
      headers: incomplete(Date.now() - day, firstPages.length === 1 ? "page-two" : "fresh"),
    });
  });
  await openDashboard(page);
  await searchBox(page).fill("rare");
  const older = shown(page.getByRole("button", { name: "Search older" }));
  await older.click();
  await expect(rows(page)).toHaveCount(4);

  await captureRequest("/plain/arrival", new Date());
  // The top is read once more, quietly: the matches stay, and so does the
  // place "Search older" goes on from.
  await expect.poll(() => firstPages.length, { timeout: 15000 }).toBe(2);
  await page.waitForLoadState("networkidle");
  await expect(rows(page)).toHaveCount(4);
  await expect(shown(page.getByText("Searching..."))).toHaveCount(0);
  await older.click();
  await expect.poll(() => continued).toEqual(["page-two", "page-three"]);
  await expect(rows(page)).toHaveCount(4);
});

test("oldest first searches forward and offers to search newer", async ({ page }) => {
  const calls = watchSearchCalls(page);
  await page.route("**/api/search/requests?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") !== "rare") return route.fallback();
    return route.fulfill({ json: [], headers: incomplete(Date.now() - 86_400_000, "next") });
  });
  await openDashboard(page);
  await shown(page.getByRole("button", { name: /Switch to oldest first/ })).click();
  await searchBox(page).fill("rare");
  await expect(shown(page.getByRole("button", { name: "Search newer" }))).toBeVisible();
  await expect(shown(page.getByText(/^Searched up to/))).toBeVisible();
  const search = calls.lists.find((url) => url.searchParams.get("q") === "rare");
  expect(search?.searchParams.get("order")).toBe("asc");
  expect(search?.searchParams.get("paged")).toBe("true");
});

test("a Load More answer for filters no longer picked is dropped", async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldUrl: URL | null = null;
  await page.route("**/api/search/requests?*", async (route) => {
    const url = new URL(route.request().url());
    // The older page of the unfiltered list.
    if (!url.searchParams.has("q") && url.searchParams.has("to") && !heldUrl) {
      heldUrl = url;
      await held;
    }
    return route.fallback();
  });
  await openDashboard(page);
  await shown(page.getByRole("button", { name: "Load More" })).click();
  await expect.poll(() => heldUrl).not.toBeNull();

  // Another method while the page is on its way: nothing here was sent with GET.
  await shown(page.getByRole("combobox", { name: "Method" })).click();
  await page.getByRole("listbox").getByRole("option", { name: "GET", exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  const answered = page.waitForResponse((response) => response.url() === heldUrl!.toString());
  release();
  await answered;
  await page.waitForLoadState("networkidle");
  // The POST rows it carried belong to the list that is gone.
  await expect(rows(page)).toHaveCount(0);
});

test("an export follows the search and says how far it reached", async ({ page }) => {
  const searchedUntil = Date.now() - 2 * 86_400_000;
  const exportCalls: (string | null)[] = [];
  await page.route("**/api/search/requests?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") !== "rare") return route.fallback();
    if (url.searchParams.get("limit") !== "200") {
      return route.fulfill({ json: [], headers: { "X-Search-Complete": "true" } });
    }
    const cursor = url.searchParams.get("cursor");
    exportCalls.push(cursor);
    // The first page runs out of time with nothing; the next finds the matches
    // and cannot go on.
    return cursor === null
      ? route.fulfill({ json: [], headers: incomplete(Date.now(), "export-two") })
      : route.fulfill({ json: await needleRows(route), headers: incomplete(searchedUntil) });
  });
  await openDashboard(page);
  await searchBox(page).fill("rare");
  await expect(shown(page.getByText("0 results"))).toBeVisible();

  let said = "";
  page.once("dialog", (dialog) => {
    said = dialog.message();
    void dialog.accept();
  });
  const download = page.waitForEvent("download");
  await shown(page.getByRole("button", { name: "Export" })).click();
  await page.getByRole("menuitem", { name: "Export JSON" }).click();
  expect((await download).suggestedFilename()).toBe("webhooks-export.json");
  await expect
    .poll(() => said)
    .toMatch(/^Exported 4 requests: what was found searching back to .+\. Older requests/);
  expect(exportCalls).toEqual([null, "export-two"]);
});
