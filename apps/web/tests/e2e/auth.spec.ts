import { test, expect } from "@playwright/test";
import { createTestUser, deleteTestUser, signInTestUser, type TestUser } from "./helpers/auth";

let testUser: TestUser;

test.beforeAll(async () => {
  testUser = await createTestUser();
});

test.afterAll(async () => {
  if (testUser) {
    await deleteTestUser(testUser.id);
  }
});

test.describe("Authentication", () => {
  test("login page renders OAuth buttons", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Sign in to webhooks.cc")).toBeVisible();
    await expect(page.getByText("Continue with GitHub")).toBeVisible();
    await expect(page.getByText("Continue with Google")).toBeVisible();
  });

  test("unauthenticated user is redirected from dashboard to login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
  });

  test("unauthenticated user is redirected from account to login", async ({ page }) => {
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
  });

  test("authenticated user can access account page and see their info", async ({ page }) => {
    await signInTestUser(page, testUser, "/account");

    await expect(page.getByText("E2E Test User")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(testUser.email)).toBeVisible();
    await expect(page.getByText("Free", { exact: true })).toBeVisible();
  });

  test("sign out redirects away from protected pages", async ({ page }) => {
    await signInTestUser(page, testUser, "/account");
    await expect(page.getByText("E2E Test User")).toBeVisible({ timeout: 15000 });

    // Sign out lives in the avatar dropdown in the header
    await page.locator("header").getByRole("button").last().click();
    await page.getByRole("menuitem", { name: "Sign Out" }).click();
    await expect(page).toHaveURL(/\/(login)?$/, { timeout: 10000 });

    // Verify we can't access protected routes anymore
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
  });

  test("session persists across page reload", async ({ page }) => {
    await signInTestUser(page, testUser, "/account");
    await expect(page.getByText("E2E Test User")).toBeVisible({ timeout: 15000 });

    // Reload the page
    await page.reload();

    // User should still be visible (session persisted via cookies)
    await expect(page.getByText("E2E Test User")).toBeVisible({ timeout: 15000 });
  });
});
