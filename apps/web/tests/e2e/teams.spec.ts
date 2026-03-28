import { test, expect } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

// Tests must run serially — they share state (team, invites, membership)
test.describe.configure({ mode: "serial" });

const ts = Date.now();
const TEAM_NAME = `E2E Team ${ts}`;
const RENAMED = `Renamed ${ts}`;

let proOwner: TestUser;
let proMember: TestUser;
let freeUser: TestUser;

test.beforeAll(async () => {
  proOwner = await createTestUser();
  proMember = await createTestUser();
  freeUser = await createTestUser();

  await admin.from("users").update({ plan: "pro" }).eq("id", proOwner.id);
  await admin.from("users").update({ plan: "pro" }).eq("id", proMember.id);
});

test.afterAll(async () => {
  await admin.from("teams").delete().eq("created_by", proOwner.id);
  await deleteTestUser(proOwner.id);
  await deleteTestUser(proMember.id);
  await deleteTestUser(freeUser.id);
});

// Helper: sign in and wait for teams page to fully load
async function goToTeams(page: import("@playwright/test").Page, user: TestUser) {
  await signInTestUser(page, user, "/teams");
  await page.waitForLoadState("networkidle");
}

test("free user sees upgrade prompt on teams page", async ({ page }) => {
  await goToTeams(page, freeUser);
  await expect(page.getByText("Teams is a Pro feature")).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("link", { name: "Upgrade to Pro" })).toBeVisible();
});

test("unauthenticated user is redirected from teams to login", async ({ page }) => {
  await page.goto("/teams");
  await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
});

test("pro user can create a team", async ({ page }) => {
  await goToTeams(page, proOwner);

  await page.getByRole("button", { name: "New Team" }).click({ timeout: 15000 });
  await expect(page.getByText("Create a new team")).toBeVisible();

  await page.getByPlaceholder("e.g. Acme Corp").fill(TEAM_NAME);
  await page.getByRole("button", { name: "Create team" }).click();

  await expect(page.getByText(TEAM_NAME)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("1 member")).toBeVisible();
});

test("pro user can navigate to team manage page", async ({ page }) => {
  await goToTeams(page, proOwner);
  await expect(page.getByText(TEAM_NAME)).toBeVisible({ timeout: 20000 });

  await page.getByRole("link", { name: "Manage" }).first().click();
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: TEAM_NAME })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
});

test("pro user can invite a member", async ({ page }) => {
  await goToTeams(page, proOwner);
  await expect(page.getByText(TEAM_NAME)).toBeVisible({ timeout: 20000 });

  await page.getByRole("link", { name: "Manage" }).first().click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Invite Member")).toBeVisible({ timeout: 15000 });

  await page.getByPlaceholder("user@example.com").fill(proMember.email);
  await page.getByRole("button", { name: "Invite" }).click();

  await expect(page.getByText("Invite sent")).toBeVisible({ timeout: 10000 });
});

test("pro member sees pending invite", async ({ page }) => {
  await goToTeams(page, proMember);

  await expect(page.getByText("Pending Invites")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(TEAM_NAME)).toBeVisible();
});

test("pro member can accept invite", async ({ page }) => {
  await goToTeams(page, proMember);
  await expect(page.getByText("Pending Invites")).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Accept" }).first().click();

  await expect(page.getByText("Teams I'm In")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("2 members")).toBeVisible();
});

test("pro member can view team manage page", async ({ page }) => {
  await goToTeams(page, proMember);
  await expect(page.getByText(TEAM_NAME)).toBeVisible({ timeout: 15000 });

  await page.getByRole("link", { name: "View" }).first().click();
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("owner", { exact: true })).toBeVisible();
  await expect(page.getByText("member", { exact: true })).toBeVisible();
});

test("avatar dropdown shows Teams link", async ({ page }) => {
  await signInTestUser(page, proOwner, "/dashboard");
  await page.waitForLoadState("networkidle");

  // Open avatar dropdown in header
  await page.locator("header").getByRole("button").last().click();

  await expect(page.getByRole("menuitem", { name: "Teams" })).toBeVisible({ timeout: 5000 });
});

test("downgrading owner shows suspended state for member", async ({ page }) => {
  await admin.from("users").update({ plan: "free" }).eq("id", proOwner.id);

  await goToTeams(page, proMember);

  await expect(page.getByText("Suspended")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("The team owner has downgraded their plan")).toBeVisible();

  // Re-upgrade for subsequent tests
  await admin.from("users").update({ plan: "pro" }).eq("id", proOwner.id);
});

test("re-upgrading owner removes suspension", async ({ page }) => {
  await goToTeams(page, proMember);

  await expect(page.getByText(TEAM_NAME)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Suspended")).not.toBeVisible();
});

test("owner can rename team", async ({ page }) => {
  await goToTeams(page, proOwner);
  await expect(page.getByText(TEAM_NAME)).toBeVisible({ timeout: 20000 });

  await page.getByRole("link", { name: "Manage" }).first().click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Team Settings")).toBeVisible({ timeout: 15000 });

  const nameInput = page.getByLabel("Team name");
  await nameInput.clear();
  await nameInput.fill(RENAMED);
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { name: RENAMED })).toBeVisible({ timeout: 10000 });
});

test("member can leave team", async ({ page }) => {
  await goToTeams(page, proMember);
  await expect(page.getByText(RENAMED)).toBeVisible({ timeout: 20000 });

  await page.getByRole("link", { name: "View" }).first().click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Leave Team" })).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Leave Team" }).click();

  await expect(page).toHaveURL(/\/teams$/, { timeout: 10000 });
});

test("owner can delete team", async ({ page }) => {
  await goToTeams(page, proOwner);
  await expect(page.getByText(RENAMED)).toBeVisible({ timeout: 20000 });

  await page.getByRole("link", { name: "Manage" }).first().click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Danger Zone")).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Delete Team" }).first().click();

  // Confirmation dialog
  await expect(page.getByText("Are you sure")).toBeVisible({ timeout: 5000 });

  // The dialog has its own Delete Team button — click it within the dialog
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete Team" }).click();

  await expect(page).toHaveURL(/\/teams$/, { timeout: 10000 });
});
