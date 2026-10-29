import { test, expect } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

/**
 * The plan page and the Team Business panel for each billing state, from
 * the account rows alone. Changes that would reach Polar are answered by a
 * stubbed route, so nothing leaves the machine.
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

test("a free account can start Pro, Business monthly or Business yearly", async ({ page }) => {
  const user = await userWith({ plan: "free" });
  await signInTestUser(page, user, "/account/plan");

  const plan = page.locator("#plan");
  await expect(plan.getByRole("button", { name: "Upgrade to Pro, $8 a month" })).toBeVisible({
    timeout: 15000,
  });
  await expect(
    plan.getByRole("button", { name: "Upgrade to Business, $29 a month" })
  ).toBeVisible();
  await expect(plan.getByRole("button", { name: "Business, $290 a year" })).toBeVisible();
  await expect(plan.getByRole("columnheader", { name: /Business/ })).toBeVisible();
});

test("Pro moves to Business now, pro rata, after saying so", async ({ page }) => {
  const user = await userWith({
    plan: "pro",
    request_limit: 100_000,
    subscription_status: "active",
    polar_subscription_id: `sub_e2e_${Date.now()}`,
    billing_interval: "month",
  });
  let body: unknown = null;
  await page.route("**/api/billing/change-plan", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { applied: "now" } });
  });
  await signInTestUser(page, user, "/account/plan");

  const plan = page.locator("#plan");
  await expect(
    plan.getByRole("button", { name: "Business, $290 a year, from the renewal" })
  ).toBeVisible({ timeout: 15000 });
  await plan.getByRole("button", { name: "Switch to Business, $29 a month" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "Start Business?" })).toBeVisible();
  await expect(dialog).toContainText("charged the difference for what is left of this period");
  await dialog.getByRole("button", { name: "Change plan" }).click();

  await expect(plan.getByText("Business starts now.")).toBeVisible();
  expect(body).toEqual({ plan: "business", interval: "month" });
});

test("a change waiting for the renewal shows, and keeping the plan drops it", async ({ page }) => {
  const user = await userWith({
    plan: "business",
    request_limit: 250_000,
    subscription_status: "active",
    polar_subscription_id: `sub_e2e_${Date.now()}`,
    billing_interval: "month",
    pending_plan: "pro",
    pending_interval: "month",
  });
  await page.route("**/api/billing/change-plan", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    await admin
      .from("users")
      .update({ pending_plan: null, pending_interval: null })
      .eq("id", user.id);
    await route.fulfill({ json: { ok: true } });
  });
  await signInTestUser(page, user, "/account/plan");

  const plan = page.locator("#plan");
  await expect(plan.getByText(/Changes to Pro on /)).toBeVisible({ timeout: 15000 });
  await expect(page.locator("#extra-pages").getByText(/Extra pages end on /)).toBeVisible();

  await plan.getByRole("button", { name: "Keep Business" }).click();
  await expect(plan.getByText("Your plan stays Business.")).toBeVisible();
  await expect(plan.getByRole("button", { name: "Pay yearly, $290" })).toBeVisible();
  await expect(page.locator("#extra-pages").getByText(/Extra pages end on /)).toHaveCount(0);
});

test("the Team Business panel offers the action its state allows", async ({ page }) => {
  const owner = await userWith({ plan: "free" });
  const { data: team, error } = await admin
    .from("teams")
    .insert({
      name: `e2e-business-${Date.now()}`,
      created_by: owner.id,
      seats: 2,
      subscription_status: "active",
      period_start: new Date(Date.now() - DAY).toISOString(),
      period_end: new Date(Date.now() + 29 * DAY).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  teams.push(team.id);
  await admin.from("team_members").upsert({ team_id: team.id, user_id: owner.id, role: "owner" });
  const { error: addonError } = await admin.rpc("apply_capacity_subscription", {
    p_user_id: null,
    p_team_id: team.id,
    p_kind: "team_business",
    p_subscription_id: `sub_e2e_tb_${Date.now()}`,
    p_status: "active",
    p_units: 0,
    p_pending_units: 0,
    p_cancel_at_period_end: true,
    p_period_start: new Date(Date.now() - DAY).toISOString(),
    p_period_end: new Date(Date.now() + 29 * DAY).toISOString(),
  });
  if (addonError) throw addonError;

  await signInTestUser(page, owner, `/teams/${team.id}`);
  const panel = page.locator("#team-business");
  await expect(panel.getByText(/Team Business ends on /)).toBeVisible({ timeout: 15000 });
  await expect(panel.getByRole("button", { name: "Keep Team Business" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "End at the renewal" })).toHaveCount(0);
  await expect(page.locator("#extra-pages").getByText(/Extra pages end on /)).toBeVisible();
});

test("after a move down, the plan page says when older requests go", async ({ page }) => {
  const user = await userWith({
    plan: "pro",
    request_limit: 100_000,
    subscription_status: "active",
    billing_interval: "month",
  });
  // Set after the plan, so the downgrade trigger cannot overwrite it.
  await admin
    .from("users")
    .update({
      retention_floor_days: 90,
      retention_floor_until: new Date(Date.now() + 5 * DAY).toISOString(),
    })
    .eq("id", user.id);
  await signInTestUser(page, user, "/account/plan");

  await expect(page.getByText(/Requests are kept 90 days until /)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Pro keeps them for 31 days/)).toBeVisible();
});
