import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
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

/** A session token for the test account, as the signed-in page holds one. */
async function accessToken(of: TestUser): Promise<string> {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data, error } = await client.auth.signInWithPassword({
    email: of.email,
    password: of.password,
  });
  if (error) throw error;
  return data.session!.access_token;
}

/** The grant a signed-in page on webhooks.cc asks for: the other site's start URL. */
async function grantStartUrl(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.post("/api/site-switch", {
    headers: { authorization: `Bearer ${token}` },
    data: { next: "/dashboard" },
  });
  expect(response.status()).toBe(200);
  const { url } = (await response.json()) as { url: string };
  expect(url).toContain(`${MAIL}/auth/switch/start?g=`);
  return url;
}

test("a ticket made in another browser signs no one in", async ({ browser }) => {
  // The account holder's browser walks the switch by hand, stopping before
  // the last hop, so the ticket stays unused.
  const maker = await browser.newContext();
  const makerPage = await maker.newPage();
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  try {
    await signInTestUser(makerPage, user, "/dashboard");
    const startUrl = await grantStartUrl(maker.request, await accessToken(user));
    const start = await maker.request.get(startUrl, { maxRedirects: 0 });
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

    // Refused, the ticket was used up: even its own browser cannot use it now.
    await makerPage.goto(finishUrl);
    await expect(makerPage).toHaveURL(/\/login\?error=switch_failed/);
  } finally {
    await maker.close();
    await other.close();
  }
});

test("a page elsewhere cannot have a ticket made for someone", async ({ browser }) => {
  const victim = await browser.newContext();
  const page = await victim.newPage();
  const stranger = await createTestUser();
  try {
    await signInTestUser(page, user, "/dashboard");
    const issued = async () => {
      const { data } = await admin
        .from("audit_events")
        .select("metadata")
        .eq("actor_user_id", user.id)
        .eq("action", "account.site_switch");
      return (data ?? []).filter(
        (row) => (row.metadata as { stage?: string } | null)?.stage === "issued"
      ).length;
    };
    const before = await issued();
    const nonce = "A".repeat(43);

    // Sent straight to issue, signed in there, with no grant: nothing made.
    await page.goto(`/auth/switch/issue?n=${nonce}&next=%2Fdashboard`);
    await expect(page).toHaveURL(new RegExp(`^${MAIL}/login\\?error=switch_failed`));

    // With a grant for another account: nothing made either.
    const strangerGrant = new URL(
      await grantStartUrl(page.request, await accessToken(stranger))
    ).searchParams.get("g")!;
    await page.goto(
      `/auth/switch/issue?g=${encodeURIComponent(strangerGrant)}&n=${nonce}&next=%2Fdashboard`
    );
    await expect(page).toHaveURL(new RegExp(`^${MAIL}/login\\?error=switch_failed`));
    expect(await issued()).toBe(before);

    // An API key cannot ask for a grant at all.
    const keyed = await page.request.post("/api/site-switch", {
      headers: { authorization: "Bearer whcc_not_a_session" },
      data: { next: "/dashboard" },
    });
    expect(keyed.status()).toBe(403);
  } finally {
    await victim.close();
    await deleteTestUser(stranger.id);
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
  // The page was on another endpoint: wait for the new one to open.
  await page.waitForURL((url) => {
    const opened = url.searchParams.get("endpoint");
    return opened !== null && opened !== slugs.mailhooks;
  });
  const slug = new URL(page.url()).searchParams.get("endpoint")!;
  const { data } = await admin.from("endpoints").select("site").eq("slug", slug).single();
  expect(data?.site).toBe("mailhooks");

  // Opened on webhooks.cc by its link: shown, with where it is listed.
  await signInTestUser(page, user, "/dashboard");
  await page.goto(`/dashboard?endpoint=${slug}`);
  await expect(page.getByText("This endpoint is listed on mailhooks.cc, not here.")).toBeVisible();

  // Its notice opens it on mailhooks.cc, signed in there through the switch.
  await page.getByRole("button", { name: "Open it on mailhooks.cc" }).click();
  await expect(page).toHaveURL(`${MAIL}/dashboard?endpoint=${slug}`);
  await expect(page.getByRole("banner").getByRole("combobox")).toContainText("Made on mail", {
    timeout: 15000,
  });

  // Switching back to webhooks.cc leaves it behind: that site does not list it.
  await page.getByRole("button", { name: "Switch site" }).click();
  await page.getByRole("menuitem", { name: /webhooks\.cc/ }).click();
  await page.waitForURL(
    (url) => url.origin !== new URL(MAIL!).origin && url.pathname === "/dashboard"
  );
  expect(new URL(page.url()).searchParams.get("endpoint")).toBeNull();
  await expect(page.getByRole("banner").getByRole("combobox")).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("banner").getByRole("combobox")).not.toContainText("Made on mail");
  await expect(page.getByText("This endpoint is listed on mailhooks.cc, not here.")).toBeHidden();
});
