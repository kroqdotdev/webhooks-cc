import { test, expect } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

/**
 * While an endpoint's requests load, the dashboard shows a skeleton, never
 * the "Waiting for the first request" state an empty endpoint gets. Coming
 * back from another page used to flash that state (or leave it up) while the
 * request list was still on its way.
 */

let testUser: TestUser;
let endpointSlug: string;

test.beforeAll(async () => {
  testUser = await createTestUser();
  const { data, error } = await admin
    .from("endpoints")
    .insert({ slug: `e2e-load-${Date.now()}`, name: "Loading E2E", user_id: testUser.id })
    .select("slug")
    .single();
  if (error) throw error;
  endpointSlug = data.slug;
  const { error: captureError } = await admin.rpc("capture_webhook", {
    p_slug: endpointSlug,
    p_method: "POST",
    p_path: "/orders",
    p_headers: { "content-type": "application/json" },
    p_body: '{"id":1}',
    p_query_params: {},
    p_content_type: "application/json",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
  });
  if (captureError) throw captureError;
});

test.afterAll(async () => {
  if (testUser) await deleteTestUser(testUser.id);
});

test("coming back to the dashboard waits for the requests instead of showing the empty state", async ({
  page,
}) => {
  await signInTestUser(page, testUser, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.getByText("/orders").first()).toBeVisible({ timeout: 15000 });

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();

  // Hold the request list back, so the moment before it arrives can be seen.
  let release: () => void = () => {};
  let intercepted = false;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/endpoints/${endpointSlug}/requests?*`, async (route) => {
    intercepted = true;
    await held;
    await route.continue();
  });

  await page.goBack();
  await expect.poll(() => intercepted, { timeout: 15000 }).toBe(true);
  // The list is held back: the skeleton shows, the empty state does not.
  await expect(page.getByTestId("requests-loading")).toBeVisible();
  await expect(page.getByText("Waiting for the first request")).toBeHidden();

  release();
  await expect(page.getByText("/orders").first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Waiting for the first request")).toBeHidden();
});

test("an endpoint list that cannot be read says so, and creates no endpoint", async ({ page }) => {
  // A new account without endpoints: an empty list would create its first one.
  const fresh = await createTestUser();
  try {
    // Every read of the list fails until the person tries again (the dev
    // server's StrictMode loads it twice, and the newer answer counts).
    let refusing = true;
    await page.route("**/api/endpoints", async (route) => {
      if (route.request().method() === "GET" && refusing) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "unavailable" }),
        });
        return;
      }
      await route.continue();
    });

    await signInTestUser(page, fresh, "/dashboard");
    await expect(page.getByRole("heading", { name: "Could not load your endpoints" })).toBeVisible({
      timeout: 15000,
    });
    // Nothing to switch to: the header shows no switcher.
    await expect(page.getByRole("combobox", { name: "Endpoint" })).toHaveCount(0);
    const count = async () =>
      (
        await admin
          .from("endpoints")
          .select("id", { count: "exact", head: true })
          .eq("user_id", fresh.id)
      ).count;
    expect(await count()).toBe(0);

    // Trying again reads the (empty) list, and only then is the first endpoint made.
    refusing = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("combobox", { name: "Endpoint" })).toBeVisible({
      timeout: 15000,
    });
    await expect.poll(count, { timeout: 15000 }).toBe(1);
  } finally {
    await deleteTestUser(fresh.id);
  }
});
