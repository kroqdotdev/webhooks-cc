import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * Unsaved endpoint settings are never dropped without asking: leaving
 * Settings by the Requests tab, the account menu's Dashboard, the browser's
 * Back, another endpoint from the switcher or a page outside the dashboard
 * opens the discard dialog. "Keep editing" keeps the edit and Settings,
 * "Discard" drops it and goes on, "Save and leave" saves and goes on. An
 * edited destination counts like a section's own form.
 */

test.describe.configure({ mode: "serial" });

const ts = Date.now();
const ALPHA = `Alpha ${ts}`;
const BETA = `Beta ${ts}`;
const alphaSlug = `e2e-unsaved-a-${ts}`;
const betaSlug = `e2e-unsaved-b-${ts}`;

let user: TestUser;
let alphaId: string;

test.beforeAll(async () => {
  user = await createTestUser();
  const { data, error } = await admin
    .from("endpoints")
    .insert([
      { slug: alphaSlug, name: ALPHA, user_id: user.id },
      { slug: betaSlug, name: BETA, user_id: user.id },
    ])
    .select("id, slug");
  if (error || !data) throw new Error(`Failed to create endpoints: ${error?.message}`);
  alphaId = data.find((endpoint) => endpoint.slug === alphaSlug)!.id as string;
});

test.afterAll(async () => {
  if (alphaId) await admin.from("endpoint_destinations").delete().eq("endpoint_id", alphaId);
  if (user) {
    await admin.from("endpoints").delete().eq("user_id", user.id);
    await deleteTestUser(user.id);
  }
});

test.beforeEach(async () => {
  // Every test starts from the saved name, whatever the one before it saved.
  await admin.from("endpoints").update({ name: ALPHA }).eq("id", alphaId);
});

const nameField = (page: Page) => page.locator("#settings-name");
const dialog = (page: Page) => page.getByRole("alertdialog");
const endpointTab = (page: Page, name: "Requests" | "Settings") =>
  page.getByRole("navigation", { name: "Endpoint" }).getByRole("button", { name });
const viewOf = (page: Page) => new URL(page.url()).searchParams.get("view");
const endpointOf = (page: Page) => new URL(page.url()).searchParams.get("endpoint");

/** Signs in on Alpha's Settings. */
async function openSettings(page: Page) {
  await signInTestUser(page, user, `/dashboard?endpoint=${alphaSlug}`);
  await endpointTab(page, "Settings").click();
  await expect(nameField(page)).toHaveValue(ALPHA, { timeout: 15000 });
}

async function editName(page: Page, name: string) {
  await nameField(page).fill(name);
  await expect(
    page.getByRole("region", { name: "Receiving" }).getByText("Save changes")
  ).toBeVisible();
}

async function expectAsked(page: Page, section = "Receiving") {
  await expect(
    dialog(page).getByRole("heading", { name: `Discard unsaved changes in ${section}?` })
  ).toBeVisible();
}

async function expectStillEditing(page: Page, name: string) {
  await expect(dialog(page)).toBeHidden();
  await expect(nameField(page)).toHaveValue(name);
  await expect.poll(() => viewOf(page)).toBe("settings");
  await expect.poll(() => endpointOf(page)).toBe(alphaSlug);
}

async function switchEndpoint(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Endpoint" }).click();
  await page.getByRole("option", { name }).click();
}

async function openAccountMenu(page: Page) {
  await page
    .getByRole("banner")
    .getByRole("button", { name: /E2E Test User/ })
    .click();
}

async function savedName(): Promise<string> {
  const { data } = await admin.from("endpoints").select("name").eq("id", alphaId).single();
  return data?.name as string;
}

test("the Requests tab asks: keep editing keeps the edit, discard drops it", async ({ page }) => {
  await openSettings(page);
  await editName(page, "Edited by tab");

  await endpointTab(page, "Requests").click();
  await expectAsked(page);
  await dialog(page).getByRole("button", { name: "Keep editing" }).click();
  await expectStillEditing(page, "Edited by tab");

  await endpointTab(page, "Requests").click();
  await dialog(page).getByRole("button", { name: "Discard" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(nameField(page)).toBeHidden();
  await expect.poll(() => viewOf(page)).toBeNull();

  // Nothing was saved, and Settings opens on the saved name again.
  expect(await savedName()).toBe(ALPHA);
  await endpointTab(page, "Settings").click();
  await expect(nameField(page)).toHaveValue(ALPHA);
});

test("save and leave saves the section, then leaves Settings", async ({ page }) => {
  await openSettings(page);
  await editName(page, `Saved ${ts}`);

  await endpointTab(page, "Requests").click();
  await expectAsked(page);
  await dialog(page).getByRole("button", { name: "Save and leave" }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15000 });
  await expect(nameField(page)).toBeHidden();
  await expect.poll(() => viewOf(page)).toBeNull();
  await expect.poll(savedName).toBe(`Saved ${ts}`);
});

test("the account menu's Dashboard link asks before Settings closes", async ({ page }) => {
  await openSettings(page);
  await editName(page, "Edited by menu");

  await openAccountMenu(page);
  await page.getByRole("menuitem", { name: "Dashboard" }).click();
  await expectAsked(page);
  // Settings stay up behind the question.
  await expect(nameField(page)).toHaveValue("Edited by menu");
  await dialog(page).getByRole("button", { name: "Keep editing" }).click();
  await expectStillEditing(page, "Edited by menu");

  await openAccountMenu(page);
  await page.getByRole("menuitem", { name: "Dashboard" }).click();
  await dialog(page).getByRole("button", { name: "Discard" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(nameField(page)).toBeHidden();
  await expect(endpointTab(page, "Requests")).toHaveAttribute("aria-current", "page");
  expect(await savedName()).toBe(ALPHA);
});

test("the browser's Back asks before Settings closes", async ({ page }) => {
  await signInTestUser(page, user, `/dashboard?endpoint=${alphaSlug}`);
  // Two history entries inside the dashboard, so Back stays on the page.
  await switchEndpoint(page, BETA);
  await expect.poll(() => endpointOf(page)).toBe(betaSlug);
  await switchEndpoint(page, ALPHA);
  await expect.poll(() => endpointOf(page)).toBe(alphaSlug);
  await endpointTab(page, "Settings").click();
  await expect(nameField(page)).toHaveValue(ALPHA, { timeout: 15000 });
  await editName(page, "Edited before Back");

  await page.goBack();
  await expectAsked(page);
  await expect(nameField(page)).toHaveValue("Edited before Back");
  await dialog(page).getByRole("button", { name: "Keep editing" }).click();
  await expectStillEditing(page, "Edited before Back");

  await page.goBack();
  await expectAsked(page);
  await dialog(page).getByRole("button", { name: "Discard" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(nameField(page)).toBeHidden();
  await expect(page).toHaveURL(/\/dashboard\?/);
  expect(await savedName()).toBe(ALPHA);
});

test("another endpoint from the switcher is held until the question is answered", async ({
  page,
}) => {
  await openSettings(page);
  await editName(page, "Edited before switch");

  await switchEndpoint(page, BETA);
  await expectAsked(page);
  // Alpha's settings stay open behind the question.
  await expect(nameField(page)).toHaveValue("Edited before switch");
  await dialog(page).getByRole("button", { name: "Keep editing" }).click();
  await expectStillEditing(page, "Edited before switch");

  await switchEndpoint(page, BETA);
  await expectAsked(page);
  await dialog(page).getByRole("button", { name: "Discard" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page).toHaveTitle(new RegExp(`^${BETA} \\|`));
  await expect.poll(() => endpointOf(page)).toBe(betaSlug);
  expect(await savedName()).toBe(ALPHA);

  // Back on Alpha, the discarded edit is gone.
  await switchEndpoint(page, ALPHA);
  await expect(page).toHaveTitle(new RegExp(`^${ALPHA} \\|`));
  await endpointTab(page, "Settings").click();
  await expect(nameField(page)).toHaveValue(ALPHA);
});

test("save and leave on a switch saves the old endpoint and stays on the new one", async ({
  page,
}) => {
  await openSettings(page);
  await editName(page, `Switched ${ts}`);

  await switchEndpoint(page, BETA);
  await expectAsked(page);
  await dialog(page).getByRole("button", { name: "Save and leave" }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15000 });
  await expect(page).toHaveTitle(new RegExp(`^${BETA} \\|`));
  await expect.poll(savedName).toBe(`Switched ${ts}`);
  // The save does not pull the dashboard back to the endpoint it left.
  await page.waitForTimeout(1000);
  expect(endpointOf(page)).toBe(betaSlug);
  await expect(page).toHaveTitle(new RegExp(`^${BETA} \\|`));
});

test("an edited destination is guarded like a section's own form", async ({ page }) => {
  await openSettings(page);
  const forwarding = page.getByRole("region", { name: "Forwarding" });
  await forwarding.getByRole("button", { name: /^Your server/ }).click();
  // Opened but untouched, a new destination is nothing to lose.
  await expect(forwarding.getByLabel("Send to")).toBeVisible();
  await endpointTab(page, "Requests").click();
  await expect(dialog(page)).toBeHidden();
  await expect(nameField(page)).toBeHidden();

  await endpointTab(page, "Settings").click();
  await forwarding.getByRole("button", { name: /^Your server/ }).click();
  await forwarding.getByLabel("Send to").fill("https://hooks.example.com/inbound");

  await endpointTab(page, "Requests").click();
  await expectAsked(page, "Forwarding");
  await dialog(page).getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(forwarding.getByLabel("Send to")).toHaveValue("https://hooks.example.com/inbound");

  // With the name edited too, both sections are named and neither is saved from the dialog.
  await editName(page, "Edited with a destination");
  await endpointTab(page, "Requests").click();
  await expectAsked(page, "Receiving and Forwarding");
  await expect(dialog(page).getByRole("button", { name: "Save and leave" })).toBeHidden();
  await dialog(page).getByRole("button", { name: "Discard" }).click();
  await expect(nameField(page)).toBeHidden();

  await endpointTab(page, "Settings").click();
  await expect(
    forwarding.getByText("Nothing is forwarded yet. Where should captures go?")
  ).toBeVisible();
  const { count } = await admin
    .from("endpoint_destinations")
    .select("id", { count: "exact", head: true })
    .eq("endpoint_id", alphaId);
  expect(count).toBe(0);
});

test("save and leave adds the destination being edited", async ({ page }) => {
  await openSettings(page);
  const forwarding = page.getByRole("region", { name: "Forwarding" });
  await forwarding.getByRole("button", { name: /^Your server/ }).click();
  await forwarding.getByLabel("Send to").fill("https://hooks.example.com/inbound");

  await endpointTab(page, "Requests").click();
  await expectAsked(page, "Forwarding");
  await dialog(page).getByRole("button", { name: "Save and leave" }).click();
  await expect(dialog(page)).toBeHidden({ timeout: 15000 });
  await expect(nameField(page)).toBeHidden();

  const { data } = await admin
    .from("endpoint_destinations")
    .select("url")
    .eq("endpoint_id", alphaId);
  expect(data?.map((row) => row.url)).toEqual(["https://hooks.example.com/inbound"]);
});

test("an existing destination keeps its edit when the list is read again", async ({ page }) => {
  // The destination the test above added.
  await openSettings(page);
  const forwarding = page.getByRole("region", { name: "Forwarding" });
  await forwarding.getByRole("button", { name: /^Open hooks\.example\.com/ }).click();
  const name = forwarding.getByLabel("Name");
  await name.fill("Edited while polling");

  // The section reads its list again every 15 seconds while it is on screen.
  await page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/endpoints/${alphaSlug}/destinations`,
    { timeout: 30000 }
  );
  await page.waitForTimeout(500);
  await expect(name).toHaveValue("Edited while polling");

  // Still unsaved, so leaving asks.
  await endpointTab(page, "Requests").click();
  await expectAsked(page, "Forwarding");
  await dialog(page).getByRole("button", { name: "Discard" }).click();
  await expect(nameField(page)).toBeHidden();
});

test("the favourite star keeps Settings open and the edit in it", async ({ page }) => {
  // Without ?endpoint= the dashboard opens the default endpoint, and the star
  // then writes the endpoint into the address.
  await signInTestUser(page, user, "/dashboard?view=settings&section=receiving");
  await expect(nameField(page)).toBeVisible({ timeout: 15000 });
  const saved = await nameField(page).inputValue();
  await nameField(page).fill("Edited before the star");

  await page.getByRole("button", { name: /^Add .* to favourites$/ }).click();
  await expect(page.getByRole("button", { name: /^Remove .* from favourites$/ })).toBeVisible();
  await expect.poll(() => endpointOf(page)).not.toBeNull();
  await page.waitForTimeout(500);
  await expect(dialog(page)).toBeHidden();
  expect(viewOf(page)).toBe("settings");
  expect(new URL(page.url()).searchParams.get("section")).toBe("receiving");
  await expect(nameField(page)).toHaveValue("Edited before the star");

  await page.getByRole("button", { name: /^Remove .* from favourites$/ }).click();
  await expect(page.getByRole("button", { name: /^Add .* to favourites$/ })).toBeVisible();
  await expect(nameField(page)).toHaveValue("Edited before the star");
  expect(saved).not.toBe("Edited before the star");
});

test("leaving the dashboard for another page asks too", async ({ page }) => {
  await openSettings(page);
  await editName(page, "Edited before leaving");

  // The account menu navigates with the router.
  await openAccountMenu(page);
  await page.getByRole("menuitem", { name: "Account" }).click();
  await expectAsked(page);
  await dialog(page).getByRole("button", { name: "Keep editing" }).click();
  await expectStillEditing(page, "Edited before leaving");
  await expect(page).toHaveURL(/\/dashboard\?/);

  // A link in the header.
  await page.getByRole("banner").getByRole("link", { name: "Docs" }).click();
  await expectAsked(page);
  await dialog(page).getByRole("button", { name: "Keep editing" }).click();
  await expectStillEditing(page, "Edited before leaving");

  await page.getByRole("banner").getByRole("link", { name: "Docs" }).click();
  await dialog(page).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(/\/docs/, { timeout: 15000 });
  expect(await savedName()).toBe(ALPHA);
});
