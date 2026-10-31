import { test, expect } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * Custom inbound domains under Account > Domains (migration 00072) and the
 * extra domains bought on top (00073): adding a domain and its records, the
 * check, routing an address once verified, a domain past what the plan
 * allows, and the extra-domain control. A change that would reach Polar is
 * answered by a stubbed route. The domains are under .example, so the DNS
 * check never finds them.
 */

const DAY = 86_400_000;
const users: TestUser[] = [];
const teams: string[] = [];

test.afterAll(async () => {
  for (const id of teams) await admin.from("teams").delete().eq("id", id);
  for (const user of users) await deleteTestUser(user.id);
});

async function userWith(fields: Record<string, unknown>): Promise<TestUser> {
  const user = await createTestUser();
  users.push(user);
  const { error } = await admin
    .from("users")
    .update({
      period_start: new Date(Date.now() - 10 * DAY).toISOString(),
      period_end: new Date(Date.now() + 20 * DAY).toISOString(),
      ...fields,
    })
    .eq("id", user.id);
  if (error) throw error;
  return user;
}

function uniqueDomain(label: string): string {
  return `${label}.acme-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`;
}

test("a Business account adds a domain, checks it, and routes an address once verified", async ({
  page,
}) => {
  const user = await userWith({ plan: "business", subscription_status: "active" });
  const { data: endpoint, error } = await admin
    .from("endpoints")
    .insert({ slug: `e2e-dom-${Date.now()}`, name: "Orders", user_id: user.id })
    .select("id, slug")
    .single();
  if (error) throw error;

  await signInTestUser(page, user, "/account/domains");
  const panel = page.locator("#domains");
  await expect(panel.getByText("1 domain included.")).toBeVisible({ timeout: 15000 });

  const domain = uniqueDomain("inbound");
  await panel.getByLabel("Add a domain").fill(domain);
  await panel.getByRole("button", { name: "Add", exact: true }).click();

  const card = panel.getByRole("listitem", { name: domain });
  await expect(card.getByText("Waiting for DNS")).toBeVisible();
  await expect(card.getByText(`_mailhooks.${domain}`)).toBeVisible();
  await card.getByRole("button", { name: "Check records" }).click();
  await expect(card.getByText(/Not found yet: the TXT record and the MX record/)).toBeVisible({
    timeout: 15000,
  });

  // Verified (as the daily check would find it): its mail can be routed.
  const { error: verifyError } = await admin
    .from("inbound_domains")
    .update({ status: "verified", verified_at: new Date().toISOString() })
    .eq("domain", domain);
  if (verifyError) throw verifyError;
  await page.reload();
  // Verified, but no address takes mail yet.
  await expect(card.getByText("No addresses yet")).toBeVisible({ timeout: 15000 });

  await card.getByRole("button", { name: "Add an address" }).click();
  await card.getByLabel("Address name").fill("orders");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText("Saved.")).toBeVisible();
  await expect(card.getByText("Receiving mail")).toBeVisible();

  // The route belongs to this test's domain, not another on the same endpoint.
  const { data: saved } = await admin
    .from("inbound_domains")
    .select("id")
    .eq("domain", domain)
    .single();
  const { data: routes } = await admin
    .from("inbound_domain_routes")
    .select("local_part, endpoint_id, domain_id")
    .eq("endpoint_id", endpoint.id);
  expect(routes).toEqual([
    { local_part: "orders", endpoint_id: endpoint.id, domain_id: saved!.id },
  ]);
});

test("a domain past the plan is refused, and extra domains go through a checkout", async ({
  page,
  baseURL,
}) => {
  const user = await userWith({ plan: "business", subscription_status: "active" });
  const older = uniqueDomain("first");
  const newer = uniqueDomain("second");
  const { error } = await admin.from("inbound_domains").insert([
    {
      user_id: user.id,
      domain: older,
      status: "verified",
      verified_at: new Date(Date.now() - 2 * DAY).toISOString(),
    },
    {
      user_id: user.id,
      domain: newer,
      status: "verified",
      verified_at: new Date(Date.now() - DAY).toISOString(),
    },
  ]);
  if (error) throw error;

  let body: unknown = null;
  await page.route("**/api/billing/capacity*", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    body = route.request().postDataJSON();
    await route.fulfill({
      json: { url: `${baseURL}/account/domains?capacity=monthly#extra-domains` },
    });
  });
  await signInTestUser(page, user, "/account/domains");

  const panel = page.locator("#domains");
  await expect(
    panel.getByRole("listitem", { name: older }).getByText("No addresses yet")
  ).toBeVisible({ timeout: 15000 });
  await expect(
    panel.getByRole("listitem", { name: newer }).getByText("Past your plan")
  ).toBeVisible();
  await expect(panel.getByText(/Mail to one verified domain is refused/)).toBeVisible();

  await panel.getByLabel("Extra domains").fill("1");
  await expect(panel.getByText("($3.00 a month)")).toBeVisible();
  await panel.locator("#extra-domains").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Your extra domains count once Polar confirms")).toBeVisible({
    timeout: 15000,
  });
  expect(body).toEqual({ resource: "domains", action: "set_monthly_blocks", blocks: 1 });
});

test("a free account is pointed at Business instead of the form", async ({ page }) => {
  const user = await userWith({ plan: "free" });
  await signInTestUser(page, user, "/account/domains");
  const panel = page.locator("#domains");
  await expect(panel.getByText(/Custom domains are part of/)).toBeVisible({ timeout: 15000 });
  await expect(panel.getByLabel("Add a domain")).toHaveCount(0);
  await expect(panel.getByLabel("Extra domains")).toHaveCount(0);
});

test("a Team Business owner manages the team's domains on the team page", async ({ page }) => {
  const owner = await userWith({ plan: "free" });
  const { data: team, error } = await admin
    .from("teams")
    .insert({
      name: `Acme domains ${Date.now()}`,
      created_by: owner.id,
      seats: 1,
      subscription_status: "active",
      business: true,
    })
    .select("id")
    .single();
  if (error) throw error;
  teams.push(team.id);
  const { error: memberError } = await admin
    .from("team_members")
    .upsert({ team_id: team.id, user_id: owner.id, role: "owner" });
  if (memberError) throw memberError;

  await signInTestUser(page, owner, `/teams/${team.id}`);
  const panel = page.locator("#domains");
  await expect(panel.getByText("1 domain included.")).toBeVisible({ timeout: 15000 });
  await expect(panel.getByLabel("Add a domain")).toBeVisible();
});
