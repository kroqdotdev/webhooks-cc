import { test, expect } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  findUserIdByEmail,
  generateMagicLinkTokenHash,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * mailhooks.cc, the second site the app serves (lib/site.ts): its own pages,
 * the app under its name with a mail-first dashboard, a sender page's layout
 * added to an endpoint, and an email link opened on webhooks.cc that signs
 * the person in on mailhooks.cc. Needs a build with NEXT_PUBLIC_MAILHOOKS_URL
 * (the suite is skipped without one).
 */

const MAIL = process.env.NEXT_PUBLIC_MAILHOOKS_URL;

test.skip(!MAIL, "NEXT_PUBLIC_MAILHOOKS_URL is not set");
test.describe.configure({ mode: "serial" });

let user: TestUser;
let endpointId: string;
let endpointSlug: string;

test.beforeAll(async () => {
  user = await createTestUser();
  const { data, error } = await admin
    .from("endpoints")
    .insert({ slug: `e2e-mail-${Date.now()}`, name: "Orders", user_id: user.id })
    .select("id, slug")
    .single();
  if (error) throw error;
  endpointId = data.id;
  endpointSlug = data.slug;
});

test.afterAll(async () => {
  if (endpointId) await admin.from("endpoints").delete().eq("id", endpointId);
  if (user) await deleteTestUser(user.id);
});

test("mailhooks.cc has its own pages, and sends webhooks.cc's elsewhere", async ({ page }) => {
  await page.goto(`${MAIL}/`);
  await expect(page).toHaveTitle(/^mailhooks\.cc: /);
  const header = page.getByRole("banner");
  await expect(header.getByRole("link", { name: "mailhooks.cc" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Senders" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Turn the emails you receive into structured data" })
  ).toBeVisible();

  await page.getByRole("link", { name: "Compare plans" }).click();
  await expect(page).toHaveURL(`${MAIL}/pricing`);
  await expect(page.getByRole("heading", { name: "Pricing", level: 1 })).toBeVisible();

  await page.goto(`${MAIL}/parse/shopify-orders`);
  await expect(page.getByRole("heading", { name: "Parse Shopify order emails" })).toBeVisible();
  await expect(page.getByText('"customer": "Jane Doe"')).toBeVisible();

  // Docs live on webhooks.cc.
  const response = await page.goto(`${MAIL}/docs/layouts`);
  expect(new URL(page.url()).host).not.toBe(new URL(MAIL!).host);
  expect(response?.ok()).toBe(true);
});

async function captureEmail(subject: string) {
  const text = "Thanks for your order.";
  const { error } = await admin.rpc("capture_webhook", {
    p_slug: endpointSlug,
    p_method: "EMAIL",
    p_path: `${endpointSlug}@mailhooks.cc`,
    p_headers: { subject, from: "Acme <orders@acme.example>" },
    p_body: `Subject: ${subject}\r\n\r\n${text}`,
    p_query_params: {},
    p_content_type: "message/rfc822",
    p_ip: "192.0.2.10",
    p_received_at: new Date().toISOString(),
    p_body_raw: null,
    p_kind: "email",
    p_email: {
      subject,
      from: [{ name: "Acme", address: "orders@acme.example" }],
      to: [{ name: null, address: `${endpointSlug}@mailhooks.cc` }],
      text,
    },
    p_dedupe_key: null,
    p_retry: false,
    p_size: null,
  });
  if (error) throw error;
}

test("the dashboard on mailhooks.cc is under its name and opens on emails", async ({ page }) => {
  // An empty endpoint leads with its address.
  await signInTestUser(page, user, "/pricing", MAIL);
  await page.goto(`${MAIL}/dashboard?endpoint=${endpointSlug}`);
  await expect(page.getByText("Send an email")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Team collaboration")).toHaveCount(0);

  // With mail in it, the list opens on emails.
  await captureEmail("Order 1 confirmed");
  // The dashboard's live connection keeps the network busy: no networkidle here.
  await page.goto(`${MAIL}/dashboard?endpoint=${endpointSlug}`);
  await expect(page).toHaveTitle("Dashboard | mailhooks.cc");
  await expect(page.getByRole("banner").getByRole("link", { name: "mailhooks.cc" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Email/ })).toHaveAttribute(
    "aria-checked",
    "true",
    {
      timeout: 15000,
    }
  );
});

test("a sender page's layout is added to an endpoint", async ({ page }) => {
  await signInTestUser(page, user, "/parse/etsy-sales", MAIL);
  await page.getByRole("link", { name: "Use this layout" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add the Etsy sales layout" })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole("button", { name: "Add layout" }).click();
  await expect(dialog).toBeHidden({ timeout: 15000 });
  await expect(page).toHaveURL(new RegExp(`endpoint=${endpointSlug}`));

  const { data } = await admin.from("endpoints").select("layouts").eq("id", endpointId).single();
  expect((data?.layouts as { id: string }[]).map((layout) => layout.id)).toEqual(["etsy-sales"]);
});

test("a layout added to another endpoint opens that endpoint's Layouts", async ({ page }) => {
  const { data: other, error } = await admin
    .from("endpoints")
    .insert({ slug: `e2e-mail-other-${Date.now()}`, name: "Receipts", user_id: user.id })
    .select("id, slug")
    .single();
  if (error) throw error;
  try {
    // Open the dashboard on the first endpoint, then import into the other one.
    await signInTestUser(
      page,
      user,
      `/dashboard?endpoint=${endpointSlug}&template=shopify-orders`,
      MAIL
    );
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Add the Shopify orders layout" })
    ).toBeVisible({
      timeout: 15000,
    });
    await dialog.getByLabel("Endpoint").selectOption(other.slug);
    await dialog.getByRole("button", { name: "Add layout" }).click();
    await expect(dialog).toBeHidden({ timeout: 15000 });
    await expect(page).toHaveURL(new RegExp(`endpoint=${other.slug}`));
    await expect(page.getByRole("region", { name: "Layouts" })).toBeVisible({ timeout: 15000 });
  } finally {
    await admin.from("endpoints").delete().eq("id", other.id);
  }
});

test("a link naming an unknown layout says so and can be closed", async ({ page }) => {
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}&template=nope`, MAIL);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "That layout is not available" })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/template=/);
});

test("an email link asked for on mailhooks.cc signs in there, even opened on webhooks.cc", async ({
  page,
  baseURL,
}) => {
  const hash = await generateMagicLinkTokenHash(user.email);
  const redirectTo = `${MAIL}/dashboard?endpoint=${endpointSlug}`;
  await page.goto(
    `${baseURL}/auth/confirm?token_hash=${encodeURIComponent(hash)}&type=email&redirect_to=${encodeURIComponent(redirectTo)}`
  );
  await expect(page).toHaveURL(redirectTo, { timeout: 15000 });
  await expect(page).toHaveTitle("Dashboard | mailhooks.cc");

  // Emails sent later (quota, alerts) link to the site it signed in on.
  const { data } = await admin.from("users").select("home_site").eq("id", user.id).single();
  expect(data?.home_site).toBe("mailhooks");
});

test("mailhooks.cc renders in the style the project picked", async ({ page }, testInfo) => {
  // The classic project stores its pick for this origin too (playwright.config.ts).
  await page.goto(`${MAIL}/`);
  const style = testInfo.project.name === "chromium-classic" ? "classic" : "clean";
  await expect(page.locator("html")).toHaveAttribute("data-style", style);
});

test("signs up on mailhooks.cc", async ({ page }) => {
  const email = `e2e-mail-signup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@webhooks-test.local`;
  try {
    await page.goto(`${MAIL}/login`);
    await expect(page).toHaveTitle(/mailhooks\.cc/);
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("a-long-enough-password");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Check your email")).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(new RegExp(`^${MAIL!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    const id = await findUserIdByEmail(email);
    if (id) await deleteTestUser(id);
  }
});

test("signs in with a password on mailhooks.cc and stays there", async ({ page }) => {
  await page.goto(`${MAIL}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`^${MAIL!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/dashboard`),
    {
      timeout: 20000,
    }
  );
  await expect(page).toHaveTitle("Dashboard | mailhooks.cc");
});
