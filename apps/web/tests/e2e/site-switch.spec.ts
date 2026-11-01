import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * The two sites side by side (lib/site.ts): each dashboard lists the
 * endpoints listed on it and on both (migration 00078), the header's
 * switcher carries the sign-in across (lib/site-switch.ts), a ticket made in
 * another browser signs no one in, and an endpoint made on mailhooks.cc is
 * listed there. Needs a build with NEXT_PUBLIC_MAILHOOKS_URL.
 */

const MAIL = process.env.NEXT_PUBLIC_MAILHOOKS_URL;

test.skip(!MAIL, "NEXT_PUBLIC_MAILHOOKS_URL is not set");
test.describe.configure({ mode: "serial" });

let user: TestUser;
const slugs = {
  webhooks: `e2e-site-web-${Date.now()}`,
  mailhooks: `e2e-site-mail-${Date.now()}`,
  both: `e2e-site-both-${Date.now()}`,
};

test.beforeAll(async () => {
  user = await createTestUser();
  const { error } = await admin.from("endpoints").insert([
    { slug: slugs.webhooks, name: "Hooks only", user_id: user.id, site: "webhooks" },
    { slug: slugs.mailhooks, name: "Mail only", user_id: user.id, site: "mailhooks" },
    { slug: slugs.both, name: "Everywhere", user_id: user.id, site: "both" },
  ]);
  if (error) throw error;
});

test.afterAll(async () => {
  if (user) {
    await admin.from("endpoints").delete().eq("user_id", user.id);
    await deleteTestUser(user.id);
  }
});

/** The names the header's endpoint switcher offers. */
async function listedNames(page: Page): Promise<string[]> {
  await page.getByRole("banner").getByRole("combobox").click();
  const names = await page.getByRole("option").allTextContents();
  await page.keyboard.press("Escape");
  return names.map((name) => name.trim());
}

test("each site lists its own endpoints and those on both", async ({ page }) => {
  await signInTestUser(page, user, "/dashboard");
  await page.goto(`/dashboard?endpoint=${slugs.both}`);
  expect(await listedNames(page)).toEqual(expect.arrayContaining(["Hooks only", "Everywhere"]));
  expect(await listedNames(page)).not.toContain("Mail only");

  await signInTestUser(page, user, "/dashboard", MAIL);
  await page.goto(`${MAIL}/dashboard?endpoint=${slugs.both}`);
  expect(await listedNames(page)).toEqual(expect.arrayContaining(["Mail only", "Everywhere"]));
  expect(await listedNames(page)).not.toContain("Hooks only");
});

test("the switcher carries the sign-in to mailhooks.cc and back", async ({ browser }) => {
  // A fresh browser: signed in on webhooks.cc only.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signInTestUser(page, user, "/dashboard");
    await page.goto(`/dashboard?endpoint=${slugs.both}`);
    await expect(page.getByRole("banner").getByRole("combobox")).toContainText("Everywhere", {
      timeout: 15000,
    });

    await page.getByRole("button", { name: "Switch site" }).click();
    await page.getByRole("menuitem", { name: /mailhooks\.cc/ }).click();
    await expect(page).toHaveURL(`${MAIL}/dashboard?endpoint=${slugs.both}`);
    await expect(
      page.getByRole("banner").getByRole("link", { name: "mailhooks.cc" })
    ).toBeVisible();
    await expect(page.getByRole("banner").getByRole("combobox")).toContainText("Everywhere", {
      timeout: 15000,
    });

    await page.getByRole("button", { name: "Switch site" }).click();
    await page.getByRole("menuitem", { name: /webhooks\.cc/ }).click();
    await expect(page).toHaveURL(/\/dashboard\?endpoint=/);
    await expect(page.getByRole("banner").getByRole("link", { name: "webhooks.cc" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a ticket made in another browser signs no one in", async ({ browser }) => {
  // The account holder's browser walks the switch by hand, stopping before
  // the last hop, so the ticket stays unused.
  const maker = await browser.newContext();
  const makerPage = await maker.newPage();
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  try {
    await signInTestUser(makerPage, user, "/dashboard");
    const start = await maker.request.get(`${MAIL}/auth/switch/start?next=%2Fdashboard`, {
      maxRedirects: 0,
    });
    expect(start.status()).toBe(303);
    const issue = await maker.request.get(start.headers().location, { maxRedirects: 0 });
    expect(issue.status()).toBe(303);
    const finishUrl = issue.headers().location;
    expect(finishUrl).toContain(`${MAIL}/auth/switch/finish?t=`);

    // Someone else's browser opens it: no nonce cookie of its own, no session.
    await otherPage.goto(finishUrl);
    await expect(otherPage).toHaveURL(/\/login\?error=switch_failed/);
    await expect(otherPage.getByText(/could not be carried over/)).toBeVisible();
    await otherPage.goto(`${MAIL}/dashboard`);
    await expect(otherPage).toHaveURL(/\/login/);

    // The same ticket in the browser it was made for signs in: the nonce,
    // not the ticket, is what turned the other browser away.
    await makerPage.goto(finishUrl);
    await expect(makerPage).toHaveURL(`${MAIL}/dashboard`);
    await expect(
      makerPage.getByRole("banner").getByRole("link", { name: "mailhooks.cc" })
    ).toBeVisible();
  } finally {
    await maker.close();
    await other.close();
  }
});

test("an endpoint made on mailhooks.cc is listed there, not on webhooks.cc", async ({ page }) => {
  await signInTestUser(page, user, "/dashboard", MAIL);
  await page.goto(`${MAIL}/dashboard?endpoint=${slugs.mailhooks}`);
  await page.getByRole("button", { name: "New Endpoint" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: "mailhooks.cc" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await dialog.getByLabel("Name (optional)").fill("Made on mail");
  await dialog.getByRole("button", { name: "Create Endpoint" }).click();
  await expect(page).toHaveURL(/\/dashboard\?endpoint=/);
  const slug = new URL(page.url()).searchParams.get("endpoint")!;
  const { data } = await admin.from("endpoints").select("site").eq("slug", slug).single();
  expect(data?.site).toBe("mailhooks");

  // Opened on webhooks.cc by its link: shown, with where it is listed.
  await signInTestUser(page, user, "/dashboard");
  await page.goto(`/dashboard?endpoint=${slug}`);
  await expect(page.getByText("This endpoint is listed on mailhooks.cc, not here.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open it on mailhooks.cc" })).toBeVisible();
});
