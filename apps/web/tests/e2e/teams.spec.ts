import { test, expect } from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  signInTestUser,
  admin,
  type TestUser,
} from "./helpers/auth";

// Tests must run serially — they share state (team, subscription, invites, membership)
test.describe.configure({ mode: "serial" });

const ts = Date.now();
const TEAM_NAME = `E2E Team ${ts}`;
const RENAMED = `Renamed ${ts}`;

// Team access hangs off the team's own subscription, never a personal plan:
// the owner is deliberately on the free plan, and one invitee on each plan.
let owner: TestUser;
let proMember: TestUser;
let freeMember: TestUser;

/** The one team this suite creates. Set by the create test, used to open it directly. */
let teamId: string;

test.beforeAll(async () => {
  owner = await createTestUser();
  proMember = await createTestUser();
  freeMember = await createTestUser();

  await admin.from("users").update({ plan: "pro" }).eq("id", proMember.id);
});

test.afterAll(async () => {
  await admin.from("teams").delete().eq("created_by", owner.id);
  await deleteTestUser(owner.id);
  await deleteTestUser(proMember.id);
  await deleteTestUser(freeMember.id);
});

// Helper: sign in and wait for teams page to fully load
async function goToTeams(page: import("@playwright/test").Page, user: TestUser) {
  await signInTestUser(page, user, "/teams");
  await page.waitForLoadState("networkidle");
}

/**
 * Opens the team's manage page directly and does not return until its data has
 * landed.
 *
 * The page renders an empty shell — blank `<h1>`, no owner-only sections — until
 * `/api/teams` resolves, so any interaction that starts before that races the
 * fetch (a late response resets controlled inputs). Gating on the heading, which
 * only ever holds the fetched name, removes that window for every caller.
 */
async function openTeamPage(
  page: import("@playwright/test").Page,
  user: TestUser,
  expectedName: string
) {
  if (!teamId) throw new Error("teamId is unset — the create-team test must run first");
  await signInTestUser(page, user, `/teams/${teamId}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: expectedName })).toBeVisible({ timeout: 20000 });
}

/**
 * Moves the suite's team between billing states directly.
 *
 * Checkout is a Polar redirect, so e2e cannot buy a subscription. Writing the
 * columns the webhook would have written exercises every downstream gate
 * (invite, accept, suspension UI) without leaving `polar_subscription_id` set —
 * which keeps seat assignment from calling Polar at all.
 */
async function setTeamBilling(patch: Record<string, unknown>) {
  const { error } = await admin.from("teams").update(patch).eq("created_by", owner.id);
  if (error) throw new Error(`Failed to update team billing: ${error.message}`);
}

async function subscribeTeam(seats: number) {
  await setTeamBilling({
    subscription_status: "active",
    seats,
    requests_used: 0,
    request_limit: seats * 100_000,
    period_start: new Date().toISOString(),
    period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    cancel_at_period_end: false,
  });
}

async function unsubscribeTeam() {
  await setTeamBilling({ subscription_status: null, period_end: null });
}

test("user with no teams sees the create form, not an upgrade wall", async ({ page }) => {
  await goToTeams(page, freeMember);

  await expect(page.getByRole("button", { name: "New Team" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("You're not in a team yet")).toBeVisible();
  await expect(page.getByText("Teams are $12/seat/mo")).toBeVisible();

  // The Pro wall is gone — teams are gated by the team's own subscription
  await expect(page.getByText("Teams is a Pro feature")).not.toBeVisible();
  await expect(page.getByRole("link", { name: "Upgrade to Pro" })).not.toBeVisible();
});

test("unauthenticated user is redirected from teams to login", async ({ page }) => {
  await page.goto("/teams");
  await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
});

test("a free-plan user can create a team, which starts suspended", async ({ page }) => {
  await goToTeams(page, owner);

  await page.getByRole("button", { name: "New Team" }).click({ timeout: 15000 });
  await expect(page.getByText("Create a new team")).toBeVisible();

  await page.getByPlaceholder("e.g. Acme Corp").fill(TEAM_NAME);
  await page.getByRole("button", { name: "Create team" }).click();

  await expect(page.getByText(TEAM_NAME)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("1 member")).toBeVisible();

  // A brand-new team has no subscription yet
  await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
  await expect(page.getByText("Some of your teams are suspended")).toBeVisible();

  const { data, error } = await admin
    .from("teams")
    .select("id")
    .eq("created_by", owner.id)
    .maybeSingle();
  if (error || !data) throw new Error(`Created team not found: ${error?.message ?? "no row"}`);
  teamId = data.id as string;

  // Later tests open the team directly, so keep the index link itself covered
  await expect(page.getByRole("link", { name: "Manage" })).toHaveAttribute(
    "href",
    `/teams/${teamId}`
  );
});

test("unsubscribed team shows the subscribe card with seat pricing", async ({ page }) => {
  await openTeamPage(page, owner, TEAM_NAME);

  await expect(page.getByText("Team suspended — no active subscription")).toBeVisible();
  await expect(page.getByText("No active subscription", { exact: true })).toBeVisible();
  await expect(page.getByText("$12/seat/mo = $36/mo")).toBeVisible();
  await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
});

test("owner cannot invite while the team has no subscription", async ({ page }) => {
  await openTeamPage(page, owner, TEAM_NAME);

  await page.getByPlaceholder("user@example.com").fill(proMember.email);
  await page.getByRole("button", { name: "Invite" }).click();

  await expect(page.getByText("This team needs an active Teams subscription")).toBeVisible({
    timeout: 10000,
  });
});

test("owner can invite members once the team is subscribed", async ({ page }) => {
  await subscribeTeam(2);

  await openTeamPage(page, owner, TEAM_NAME);

  // Suspension is gone now that the team carries a subscription
  await expect(page.getByText("Team suspended — no active subscription")).not.toBeVisible();

  await page.getByPlaceholder("user@example.com").fill(proMember.email);
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Invite sent")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(proMember.email)).toBeVisible();

  await page.getByPlaceholder("user@example.com").fill(freeMember.email);
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText(freeMember.email)).toBeVisible({ timeout: 10000 });
});

test("free-plan invitee sees a plain Accept button, not an upgrade link", async ({ page }) => {
  await goToTeams(page, freeMember);

  await expect(page.getByText("Pending Invites")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(TEAM_NAME)).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Upgrade to accept" })).not.toBeVisible();

  // No empty team sections for someone who only has an invite
  await expect(page.getByText("My Teams")).not.toBeVisible();
  await expect(page.getByText("Teams I'm In")).not.toBeVisible();
});

test("accepting an invite to a lapsed team surfaces the inactive error", async ({ page }) => {
  await unsubscribeTeam();

  await goToTeams(page, freeMember);
  await expect(page.getByText("Pending Invites")).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Accept" }).first().click();

  await expect(page.getByText("This team needs an active Teams subscription")).toBeVisible({
    timeout: 10000,
  });

  // The invite stays pending, so it is still retryable once the team subscribes
  await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();

  await subscribeTeam(2);
});

test("invitee can accept while a seat is free", async ({ page }) => {
  await goToTeams(page, proMember);
  await expect(page.getByText("Pending Invites")).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Accept" }).first().click();

  await expect(page.getByText("Teams I'm In")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("2 members")).toBeVisible();
});

test("accepting with every seat taken surfaces the seat error", async ({ page }) => {
  // Two seats, two members (owner + proMember) — freeMember has nowhere to sit
  await goToTeams(page, freeMember);
  await expect(page.getByText("Pending Invites")).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Accept" }).first().click();

  await expect(
    page.getByText("Team has no available seats — ask the owner to add seats")
  ).toBeVisible({ timeout: 10000 });
});

test("invitee can accept after the owner adds a seat", async ({ page }) => {
  await subscribeTeam(3);

  await goToTeams(page, freeMember);
  await expect(page.getByText("Pending Invites")).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Accept" }).first().click();

  await expect(page.getByText("Teams I'm In")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("3 members")).toBeVisible();
});

test("member can view team manage page", async ({ page }) => {
  // The member's index links to the same page, under a different label
  await goToTeams(page, proMember);
  await expect(page.getByRole("link", { name: "View" })).toHaveAttribute(
    "href",
    `/teams/${teamId}`,
    { timeout: 15000 }
  );

  await openTeamPage(page, proMember, TEAM_NAME);

  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("owner", { exact: true })).toBeVisible();
  await expect(page.getByText("member", { exact: true }).first()).toBeVisible();

  // Members see the team's subscription state, without owner-only controls
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update seats" })).not.toBeVisible();
});

test("avatar dropdown shows Teams link", async ({ page }) => {
  await signInTestUser(page, owner, "/dashboard");
  await page.waitForLoadState("networkidle");

  // Open avatar dropdown in header
  await page.locator("header").getByRole("button").last().click();

  await expect(page.getByRole("menuitem", { name: "Teams" })).toBeVisible({ timeout: 5000 });
});

test("a lapsed subscription shows the suspended state for members", async ({ page }) => {
  await unsubscribeTeam();

  await goToTeams(page, proMember);

  await expect(page.getByText("Suspended", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("This team has no active subscription")).toBeVisible();

  // Re-subscribe for subsequent tests
  await subscribeTeam(3);
});

test("re-subscribing removes the suspended state", async ({ page }) => {
  await goToTeams(page, proMember);

  await expect(page.getByText(TEAM_NAME)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Suspended", { exact: true })).not.toBeVisible();
});

test("owner can rename team", async ({ page }) => {
  await openTeamPage(page, owner, TEAM_NAME);
  await expect(page.getByText("Team Settings")).toBeVisible();

  const nameInput = page.getByLabel("Team name");
  await nameInput.clear();
  await nameInput.fill(RENAMED);

  // Save stays disabled while the field still holds the fetched name, so this
  // also proves no late response overwrote what was just typed.
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled();
  await save.click();

  await expect(page.getByRole("heading", { name: RENAMED })).toBeVisible({ timeout: 10000 });
});

test("member can leave team", async ({ page }) => {
  await openTeamPage(page, proMember, RENAMED);
  await expect(page.getByRole("heading", { name: "Leave Team" })).toBeVisible();

  await page.getByRole("button", { name: "Leave Team" }).click();

  await expect(page).toHaveURL(/\/teams$/, { timeout: 10000 });
});

test("owner can delete team", async ({ page }) => {
  await openTeamPage(page, owner, RENAMED);
  await expect(page.getByText("Danger Zone")).toBeVisible();

  await page.getByRole("button", { name: "Delete Team" }).first().click();

  // Confirmation dialog
  await expect(page.getByText("Are you sure")).toBeVisible({ timeout: 5000 });

  // The dialog has its own Delete Team button — click it within the dialog
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete Team" }).click();

  await expect(page).toHaveURL(/\/teams$/, { timeout: 10000 });
});
