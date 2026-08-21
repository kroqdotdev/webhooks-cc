import { test, expect } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  findUserIdByEmail,
  generateMagicLinkTokenHash,
  generateRecoveryTokenHash,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

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
  test("login page renders OAuth buttons and the email form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Sign in to webhooks.cc")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Forgot password?" })).toBeVisible();
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

    await expect(page.getByRole("main").getByText("E2E Test User")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(testUser.email)).toBeVisible();
    await expect(page.getByText("Free", { exact: true })).toBeVisible();
  });

  test("sign out redirects away from protected pages", async ({ page }) => {
    await signInTestUser(page, testUser, "/account");
    await expect(page.getByRole("main").getByText("E2E Test User")).toBeVisible({ timeout: 15000 });

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
    await expect(page.getByRole("main").getByText("E2E Test User")).toBeVisible({ timeout: 15000 });

    // Reload the page
    await page.reload();

    // User should still be visible (session persisted via cookies)
    await expect(page.getByRole("main").getByText("E2E Test User")).toBeVisible({ timeout: 15000 });
  });
});

test.describe("Email/password authentication", () => {
  test("signs in through the form with a wrong password error first", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(testUser.email);
    await page.getByLabel("Password").fill("definitely-not-it");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator('main [role="alert"]')).toHaveText(/Incorrect email or password/);

    await page.getByLabel("Password").fill(testUser.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
  });

  test("sign-up shows the generic check-your-email state", async ({ page }) => {
    const email = `e2e-signup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@webhooks-test.local`;
    try {
      await page.goto("/login");
      await page.getByRole("button", { name: "Create an account" }).click();
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill("short");
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page.locator('main [role="alert"]')).toHaveText(/at least 8 characters/);

      await page.getByLabel("Password").fill("a-long-enough-password");
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page.getByText("Check your email")).toBeVisible({ timeout: 20000 });
      await expect(page.getByText(email)).toBeVisible();
    } finally {
      const id = await findUserIdByEmail(email);
      if (id) await deleteTestUser(id);
    }
  });

  test("recovery link through /auth/confirm sets a new password that then signs in", async ({
    page,
    browser,
  }) => {
    const user = await createTestUser();
    const newPassword = "a-brand-new-password";
    try {
      const tokenHash = await generateRecoveryTokenHash(user.email);
      await page.goto(
        `/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=recovery&next=/auth/reset-password`
      );
      await expect(page).toHaveURL(/\/auth\/reset-password/, { timeout: 20000 });
      await expect(page.getByText("Choose a new password")).toBeVisible({ timeout: 15000 });

      await page.getByLabel("New password", { exact: true }).fill(newPassword);
      await page.getByLabel("Confirm new password").fill("does-not-match");
      await page.getByRole("button", { name: "Update password" }).click();
      await expect(page.locator('main [role="alert"]')).toHaveText(/don't match/);

      await page.getByLabel("Confirm new password").fill(newPassword);
      await page.getByRole("button", { name: "Update password" }).click();
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });

      // Fresh browser context: the new password signs in through the form.
      const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
      const fresh = await context.newPage();
      try {
        await fresh.goto("/login");
        await fresh.getByLabel("Email").fill(user.email);
        await fresh.getByLabel("Password").fill(newPassword);
        await fresh.getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(fresh).toHaveURL(/\/dashboard/, { timeout: 20000 });
      } finally {
        await context.close();
      }
    } finally {
      await deleteTestUser(user.id);
    }
  });

  test("/auth/confirm honors a same-origin redirect_to and ignores a foreign one", async ({
    page,
  }) => {
    // A magic-link hash verifies under type=email just like a signup
    // confirmation does, so this exercises the redirect_to handling the
    // confirmation template relies on without an SMTP round trip.
    const base = test.info().project.use.baseURL!;
    const user = await createTestUser();
    try {
      const ownHash = await generateMagicLinkTokenHash(user.email);
      await page.goto(
        `/auth/confirm?token_hash=${encodeURIComponent(ownHash)}&type=email&redirect_to=${encodeURIComponent(`${base}/account?from=email`)}`
      );
      await expect(page).toHaveURL(/\/account\?from=email/, { timeout: 20000 });
      await expect(page.getByRole("main").getByText("E2E Test User")).toBeVisible({
        timeout: 15000,
      });

      const foreignHash = await generateMagicLinkTokenHash(user.email);
      await page.goto(
        `/auth/confirm?token_hash=${encodeURIComponent(foreignHash)}&type=email&redirect_to=${encodeURIComponent("https://evil.example/steal")}`
      );
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 20000 });
    } finally {
      await deleteTestUser(user.id);
    }
  });

  test("/auth/confirm with a bad token lands on login with an error", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=not-a-real-hash&type=recovery");
    await expect(page).toHaveURL(/\/login\?error=link_invalid/, { timeout: 20000 });
    await expect(page.locator('main [role="alert"]')).toHaveText(/invalid or has expired/);
  });

  test("/auth/reset-password without a session shows the invalid-link state", async ({ page }) => {
    await page.goto("/auth/reset-password");
    await expect(page.getByText("That reset link is invalid or has expired.")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole("link", { name: "Go to sign in" })).toBeVisible();
  });
});
