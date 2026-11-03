import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * The cookie banner's answer follows a signed-in account to its other
 * browsers (lib/analytics-account-consent.ts, migration 00082): a decline
 * everywhere, an accept only where nothing was answered, and an accept from an
 * earlier visit is never saved on the account. Needs a build with
 * NEXT_PUBLIC_POSTHOG_KEY (any value; point NEXT_PUBLIC_POSTHOG_HOST at
 * nothing to send nowhere).
 */

test.skip(!process.env.NEXT_PUBLIC_POSTHOG_KEY, "no cookie banner without a PostHog key");
test.describe.configure({ mode: "serial" });

let user: TestUser;

test.beforeAll(async () => {
  user = await createTestUser();
});

test.afterAll(async () => {
  if (user) await deleteTestUser(user.id);
});

const BANNER = "Analytics, for us only";

async function savedOnAccount(): Promise<string | null> {
  const { data, error } = await admin
    .from("users")
    .select("analytics_consent")
    .eq("id", user.id)
    .single();
  if (error) throw error;
  return data.analytics_consent;
}

function consentHere(page: Page) {
  return page.evaluate(() => window.localStorage.getItem("whk_analytics_consent"));
}

test("an accept remembered from an earlier visit is not saved on the account", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const earlier = await context.newPage();
    await earlier.goto("/login");
    await earlier
      .getByRole("dialog", { name: BANNER })
      .getByRole("button", { name: "Accept" })
      .click();
    await earlier.close();

    // A new tab of the same browser: the accept is remembered, but not as given here.
    const page = await context.newPage();
    await signInTestUser(page, user, "/account");
    await expect(page.getByRole("dialog", { name: BANNER })).toBeHidden();
    await page.waitForTimeout(1000);
    expect(await savedOnAccount()).toBeNull();
  } finally {
    await context.close();
  }
});

test("the answer follows the account to a new browser, and a decline withdraws everywhere", async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    // First browser: answered on the sign-in page, then signed in in the same tab.
    const pageA = await first.newPage();
    await pageA.goto("/login");
    await pageA
      .getByRole("dialog", { name: BANNER })
      .getByRole("button", { name: "Accept" })
      .click();
    const accepted = await consentHere(pageA);
    expect(accepted).not.toBeNull();
    await signInTestUser(pageA, user, "/account");
    await expect.poll(savedOnAccount).toBe("granted");

    // Second browser: never answered; signing in answers it from the account.
    const pageB = await second.newPage();
    await signInTestUser(pageB, user, "/account");
    await expect.poll(() => consentHere(pageB)).toBe(accepted);
    await expect(pageB.getByRole("dialog", { name: BANNER })).toBeHidden();

    // Declined in the second browser, signed in: the account and the first browser follow.
    await pageB.goto("/privacy");
    await pageB.getByRole("button", { name: "Cookie settings" }).first().click();
    await pageB
      .getByRole("dialog", { name: BANNER })
      .getByRole("button", { name: "Decline" })
      .click();
    const declined = await consentHere(pageB);
    expect(declined).not.toBe(accepted);
    await expect.poll(savedOnAccount).toBe("denied");

    await pageA.reload();
    await expect.poll(() => consentHere(pageA)).toBe(declined);
    await expect(pageA.getByRole("dialog", { name: BANNER })).toBeHidden();
  } finally {
    await first.close();
    await second.close();
  }
});
