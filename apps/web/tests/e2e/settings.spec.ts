import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * The account and team settings pages: what the teams suite does not cover.
 * Billing states are written to the team row directly, as the Polar webhook
 * would, without a Polar subscription id, so nothing here calls Polar.
 */

test.describe.configure({ mode: "serial" });

const ts = Date.now();
const TEAM_NAME = `Settings Team ${ts}`;
const DAY = 86_400_000;

let owner: TestUser;
let member: TestUser;
let teamId: string;
let ownerEndpointId: string;
let memberEndpointId: string;
const memberEndpointName = `Member endpoint ${ts}`;

async function setTeam(patch: Record<string, unknown>) {
  const { error } = await admin.from("teams").update(patch).eq("id", teamId);
  if (error) throw new Error(`Failed to update team: ${error.message}`);
}

const ACTIVE = {
  subscription_status: "active",
  seats: 3,
  requests_used: 120_000,
  request_limit: 300_000,
  period_start: new Date(Date.now() - 5 * DAY).toISOString(),
  period_end: new Date(Date.now() + 25 * DAY).toISOString(),
  cancel_at_period_end: false,
  pending_seats: null,
};

async function openTeam(page: Page, user: TestUser) {
  await signInTestUser(page, user, `/teams/${teamId}`);
  await expect(page.getByRole("heading", { name: TEAM_NAME, level: 1 })).toBeVisible({
    timeout: 20000,
  });
}

test.beforeAll(async () => {
  owner = await createTestUser();
  member = await createTestUser();

  const { data: team, error } = await admin
    .from("teams")
    .insert({ name: TEAM_NAME, created_by: owner.id, ...ACTIVE })
    .select("id")
    .single();
  if (error || !team) throw new Error(`Failed to create team: ${error?.message}`);
  teamId = team.id as string;

  const joined = new Date(Date.now() - 3 * DAY).toISOString();
  const { error: membersError } = await admin.from("team_members").insert([
    { team_id: teamId, user_id: owner.id, role: "owner", joined_at: joined },
    { team_id: teamId, user_id: member.id, role: "member", joined_at: joined },
  ]);
  if (membersError) throw new Error(`Failed to add members: ${membersError.message}`);

  const { data: endpoints, error: endpointsError } = await admin
    .from("endpoints")
    .insert([
      { slug: `own-${ts}`, name: `Owner endpoint ${ts}`, user_id: owner.id },
      { slug: `mem-${ts}`, name: memberEndpointName, user_id: member.id },
    ])
    .select("id, user_id");
  if (endpointsError || !endpoints) throw new Error(`Failed to create endpoints`);
  ownerEndpointId = endpoints.find((e) => e.user_id === owner.id)!.id as string;
  memberEndpointId = endpoints.find((e) => e.user_id === member.id)!.id as string;

  const { error: shareError } = await admin
    .from("team_endpoints")
    .insert({ team_id: teamId, endpoint_id: ownerEndpointId, shared_by: owner.id });
  if (shareError) throw new Error(`Failed to share: ${shareError.message}`);
});

test.afterAll(async () => {
  await admin.from("teams").delete().eq("created_by", owner.id);
  await admin.from("endpoints").delete().in("id", [ownerEndpointId, memberEndpointId]);
  await deleteTestUser(owner.id);
  await deleteTestUser(member.id);
});

// ── Account ──────────────────────────────────────────────────────────

test("the side nav moves between account pages and lists the team", async ({ page }) => {
  await signInTestUser(page, owner, "/account");
  const nav = page.getByRole("navigation", { name: "Settings" }).last();
  await expect(nav.getByRole("link", { name: new RegExp(TEAM_NAME) })).toBeVisible({
    timeout: 15000,
  });

  await nav.getByRole("link", { name: "Plan and usage" }).click();
  await expect(page.getByRole("heading", { name: "Plan and usage", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Team pools" })).toBeVisible();

  await nav.getByRole("link", { name: "API keys" }).click();
  await expect(page.getByRole("heading", { name: "API keys", level: 1 })).toBeVisible();
});

test("a display name is saved, survives a reload, and clears back to the provider name", async ({
  page,
}) => {
  await signInTestUser(page, owner, "/account");
  const field = page.getByLabel("Display name");
  await expect(field).toHaveValue("E2E Test User", { timeout: 15000 });

  await field.fill("Renamed Owner");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Name saved.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue("Renamed Owner", { timeout: 15000 });

  await page.getByLabel("Display name").fill("");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Name saved.")).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue("E2E Test User");
});

test("old account links land on the pages that took their content", async ({ page }) => {
  await signInTestUser(page, owner, "/account?upgraded=true");
  await expect(page).toHaveURL(/\/account\/plan$/, { timeout: 15000 });
  await expect(page.getByText("Welcome to Pro")).toBeVisible();

  await page.goto("/account#connected-agents");
  await expect(page).toHaveURL(/\/account\/agents$/, { timeout: 15000 });
  await expect(page.getByTestId("connected-agents")).toBeVisible();
});

test("an API key is created once, listed, and deleted", async ({ page }) => {
  const keyName = `E2E key ${ts}`;
  await signInTestUser(page, owner, "/account/api-keys");

  await page.getByRole("button", { name: "Create key" }).click();
  await page.getByLabel("Name").fill(keyName);
  await page.getByRole("dialog").getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("dialog").getByText(/^whcc_/)).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("row", { name: new RegExp(keyName) });
  await expect(row).toBeVisible();
  await expect(row.getByText("Never")).toHaveCount(1);

  await row.getByRole("button", { name: `Delete key ${keyName}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete key" }).click();
  await expect(row).toHaveCount(0);
  const { count } = await admin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", owner.id);
  expect(count).toBe(0);
});

// ── Team ─────────────────────────────────────────────────────────────

test("the seat rail shows pooled usage and who holds each seat", async ({ page }) => {
  await openTeam(page, owner);

  await expect(
    page.getByRole("progressbar", { name: "120,000 of 300,000 requests used" })
  ).toBeVisible();
  const seats = page.getByRole("list", { name: "Seats" });
  await expect(seats.getByRole("listitem")).toHaveCount(3);
  await expect(seats.getByText("You")).toBeVisible();
  await expect(seats.getByText("Open seat")).toBeVisible();
});

test("the owner cancels a pending invite", async ({ page }) => {
  const invited = `invitee-${ts}@webhooks-test.local`;
  const { error } = await admin
    .from("team_invites")
    .insert({ team_id: teamId, invited_by: owner.id, invited_email: invited });
  if (error) throw new Error(error.message);

  await openTeam(page, owner);
  await expect(page.getByRole("cell", { name: invited, exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Seats" }).getByText("Invited")).toBeVisible();

  await page.getByRole("button", { name: `Cancel the invite to ${invited}` }).click();
  await expect(page.getByRole("cell", { name: invited, exact: true })).toHaveCount(0);

  const { count } = await admin
    .from("team_invites")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId);
  expect(count).toBe(0);
});

test("a member shares and unshares their own endpoint, and sees everyone's", async ({ page }) => {
  await openTeam(page, member);
  const shared = page.locator("#shared-endpoints");

  // The owner's endpoint is visible to the member, without an unshare control.
  await expect(shared.getByText(`Owner endpoint ${ts}`)).toBeVisible();
  await expect(shared.getByRole("button", { name: /Stop sharing Owner endpoint/ })).toHaveCount(0);

  await shared.getByRole("combobox", { name: "Share one of your endpoints" }).click();
  await page.getByRole("option", { name: memberEndpointName }).click();
  await expect(shared.getByText(memberEndpointName)).toBeVisible({ timeout: 10000 });

  await shared.getByRole("button", { name: `Stop sharing ${memberEndpointName}` }).click();
  await expect(shared.getByText(memberEndpointName)).toHaveCount(0, { timeout: 10000 });
});

test("billing states read correctly for the owner and the member", async ({ browser }) => {
  const ownerPage = await (await browser.newContext()).newPage();
  const memberPage = await (await browser.newContext()).newPage();

  await setTeam({ subscription_status: "past_due" });
  await openTeam(ownerPage, owner);
  await expect(ownerPage.getByText("Payment past due", { exact: true }).first()).toBeVisible();

  await setTeam({ subscription_status: "active", cancel_at_period_end: true });
  await ownerPage.reload();
  const billing = ownerPage.locator("#billing");
  await expect(billing.getByText("Cancels at period end")).toBeVisible({ timeout: 15000 });
  await expect(billing.getByRole("button", { name: "Keep subscription" })).toBeVisible();

  await openTeam(memberPage, member);
  const memberBilling = memberPage.locator("#billing");
  await expect(memberBilling.getByText("Cancels at period end")).toBeVisible();
  await expect(memberBilling.getByRole("button")).toHaveCount(0);

  await setTeam({ cancel_at_period_end: false, pending_seats: 2 });
  await ownerPage.reload();
  await expect(ownerPage.getByText("Drops from 3 to 2 seats", { exact: false })).toBeVisible({
    timeout: 15000,
  });
  await expect(ownerPage.getByRole("button", { name: "Keep 3 seats" })).toBeVisible();
  await expect(
    ownerPage.getByRole("list", { name: "Seats" }).getByText("Removed at renewal")
  ).toBeVisible();

  await setTeam(ACTIVE);
});

test("a seat change asks for confirmation and shows a failed quote in the dialog", async ({
  page,
}) => {
  await openTeam(page, owner);
  await page.getByRole("button", { name: "Increase seats" }).click();
  await page.getByRole("button", { name: "Update seats" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "Add 1 seat?" })).toBeVisible();
  // This team has no Polar subscription, so pricing fails; the dialog must say so
  // and keep its confirm button disabled instead of charging blind.
  await expect(dialog.getByRole("button", { name: /add seat/i })).toBeDisabled({ timeout: 15000 });
  await dialog.getByRole("button", { name: "Keep 3 seats" }).click();
  await expect(dialog).toHaveCount(0);
});

test("after checkout the page waits for activation, then shows the team", async ({ page }) => {
  await setTeam({ subscription_status: null, period_end: null });
  await signInTestUser(page, owner, `/teams/${teamId}?subscribed=true`);
  await expect(page.getByText("Activating your subscription...")).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "Subscribe" })).toHaveCount(0);

  await setTeam(ACTIVE);
  await expect(page.getByRole("heading", { name: "Seats and usage" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page).toHaveURL(new RegExp(`/teams/${teamId}$`));
});

test("opening a team re-reads it, so counts are current after navigating", async ({ page }) => {
  await signInTestUser(page, owner, "/teams");
  await expect(page.getByRole("link", { name: `Manage ${TEAM_NAME}` })).toBeVisible({
    timeout: 15000,
  });

  // Seats change while the settings area is already open.
  await setTeam({ seats: 4, request_limit: 400_000 });
  await page
    .getByRole("navigation", { name: "Settings" })
    .last()
    .getByRole("link", { name: new RegExp(TEAM_NAME) })
    .click();
  await expect(page.getByRole("list", { name: "Seats" }).getByRole("listitem")).toHaveCount(4, {
    timeout: 15000,
  });
  await setTeam(ACTIVE);
});

test("removing a member asks first, then unshares what they shared", async ({ page }) => {
  await admin
    .from("team_endpoints")
    .insert({ team_id: teamId, endpoint_id: memberEndpointId, shared_by: member.id });

  await openTeam(page, owner);
  const row = page.getByRole("row", { name: new RegExp(member.email) });
  await row.getByRole("button", { name: /^Remove/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0, { timeout: 10000 });
  await expect(page.locator("#shared-endpoints").getByText(memberEndpointName)).toHaveCount(0);

  const { count } = await admin
    .from("team_endpoints")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .eq("endpoint_id", memberEndpointId);
  expect(count).toBe(0);
});
