import { createHash, randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * The agent claim page (/agent/claim?attempt=...): signed-out redirect, the
 * request summary, a wrong code, connecting, declining, the wrong account,
 * an identity provider's link request, and Connected Agents in Account, in
 * both styles and both themes.
 * Registrations and attempts are seeded with the service role, hashed the
 * way lib/agent/claims.ts hashes them.
 */

let owner: TestUser;
let stranger: TestUser;
// Per worker: with fullyParallel each worker runs its own beforeAll/afterAll.
const registrationIds: string[] = [];
const endpointSlugs: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedAttempt(
  loginHint: string,
  options: { clientName?: string; endpoint?: boolean; idjagIss?: string } = {}
): Promise<{ attempt: string; code: string; slug: string | null; registrationId: string }> {
  const attempt = `cat_${randomBytes(24)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "")
    .padEnd(32, "x")
    .slice(0, 32)}`;
  const attemptHash = sha256(attempt);
  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  const now = Date.now();
  const { data, error } = await admin
    .from("agent_registrations")
    .insert({
      ...(options.idjagIss
        ? {
            kind: "identity_assertion" as const,
            idjag_iss: options.idjagIss,
            idjag_sub: `e2e-${randomBytes(8).toString("hex")}`,
          }
        : { kind: "anonymous" as const, client_name: options.clientName ?? "E2E agent" }),
      claim_token_hash: sha256(`clm_${randomBytes(16).toString("hex")}`),
      expires_at: new Date(now + 86_400_000).toISOString(),
      attempt_token_hash: attemptHash,
      attempt_user_code_hash: sha256(`${attemptHash}:${code}`),
      attempt_login_hint: loginHint,
      attempt_expires_at: new Date(now + 900_000).toISOString(),
      attempts_issued: 1,
    })
    .select("id, expires_at")
    .single();
  if (error) throw new Error(`seed registration: ${error.message}`);
  registrationIds.push(data.id);

  let slug: string | null = null;
  if (options.endpoint !== false) {
    slug = `e2eclaim${randomBytes(4).toString("hex")}`;
    const { error: endpointError } = await admin.from("endpoints").insert({
      slug,
      is_ephemeral: true,
      expires_at: data.expires_at,
      agent_registration_id: data.id,
    });
    if (endpointError) throw new Error(`seed endpoint: ${endpointError.message}`);
    endpointSlugs.push(slug);
  }
  return { attempt, code, slug, registrationId: data.id };
}

async function openAs(
  page: Page,
  user: TestUser,
  path: string,
  look: { style: "classic" | "clean"; theme: "light" | "dark" } = {
    style: "classic",
    theme: "light",
  }
) {
  await page.addInitScript(({ style, theme }) => {
    localStorage.setItem("ui-style", style);
    localStorage.setItem("ui-style-source", "chosen");
    localStorage.setItem("theme", theme);
  }, look);
  await signInTestUser(page, user, path);
}

test.beforeAll(async () => {
  owner = await createTestUser();
  stranger = await createTestUser();
});

test.afterAll(async () => {
  if (registrationIds.length > 0) {
    await admin.from("agent_registrations").delete().in("id", registrationIds);
    await admin.from("endpoints").delete().in("slug", endpointSlugs);
  }
  if (owner) await deleteTestUser(owner.id);
  if (stranger) await deleteTestUser(stranger.id);
});

test("signed out, the claim link goes through login and keeps the attempt", async ({ page }) => {
  const { attempt } = await seedAttempt(owner.email, { endpoint: false });
  await page.goto(`/agent/claim?attempt=${attempt}`);
  await expect(page).toHaveURL(/\/login\?redirect=/, { timeout: 15000 });
  const redirect = new URL(page.url()).searchParams.get("redirect");
  expect(redirect).toBe(`/agent/claim?attempt=${attempt}`);
});

for (const style of ["classic", "clean"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`connects an agent in ${style} ${theme}`, async ({ page }) => {
      const { attempt, code, slug } = await seedAttempt(owner.email, {
        clientName: `E2E agent ${style} ${theme}`,
      });
      await openAs(page, owner, `/agent/claim?attempt=${attempt}`, { style, theme });
      await expect(page.locator("html")).toHaveAttribute("data-style", style);

      const panel = page.getByTestId("agent-claim");
      await expect(panel.getByRole("heading", { name: "Connect an agent" })).toBeVisible({
        timeout: 15000,
      });
      await expect(panel.getByText(`E2E agent ${style} ${theme}`)).toBeVisible();
      await expect(panel.getByText("name given by the agent")).toBeVisible();
      await expect(panel.getByText(slug!, { exact: false })).toBeVisible();

      const input = panel.getByLabel("Code from the agent");
      await input.fill(code === "000000" ? "111111" : "000000");
      await panel.getByRole("button", { name: "Connect" }).click();
      await expect(panel.getByRole("alert")).toHaveText(/That code is not right\. 4 tries left\./);

      await input.fill(code);
      await panel.getByRole("button", { name: "Connect" }).click();
      await expect(panel.getByRole("heading", { name: "Agent connected" })).toBeVisible();
      await expect(panel.getByText(slug!)).toBeVisible();

      const { data: endpoint } = await admin
        .from("endpoints")
        .select("user_id, agent_registration_id")
        .eq("slug", slug!)
        .single();
      expect(endpoint).toEqual({ user_id: owner.id, agent_registration_id: null });
    });
  }
}

for (const style of ["classic", "clean"] as const) {
  test(`links an identity provider's identity in ${style}`, async ({ page }) => {
    // No provider is trusted in development, so the page falls back to the
    // issuer's host; a trusted one shows its display_name.
    const { attempt, code, registrationId } = await seedAttempt(owner.email, {
      endpoint: false,
      idjagIss: "https://idp.e2e.example",
    });
    await openAs(page, owner, `/agent/claim?attempt=${attempt}`, { style, theme: "dark" });
    const panel = page.getByTestId("agent-claim");
    await expect(panel.getByRole("heading", { name: "Connect an agent" })).toBeVisible({
      timeout: 15000,
    });
    await expect(panel.getByText("is asking to link this account")).toBeVisible();
    await expect(panel.getByText("Identity provider")).toBeVisible();
    await expect(panel.getByText("idp.e2e.example").first()).toBeVisible();
    await expect(panel.getByText("name given by the agent")).toHaveCount(0);

    await panel.getByLabel("Code from the agent").fill(code);
    await panel.getByRole("button", { name: "Connect" }).click();
    await expect(panel.getByRole("heading", { name: "Agent connected" })).toBeVisible();
    const { data } = await admin
      .from("agent_registrations")
      .select("user_id, claimed_at")
      .eq("id", registrationId)
      .single();
    expect(data?.user_id).toBe(owner.id);
  });
}

test("shows the wrong account and offers to switch", async ({ page }) => {
  const { attempt } = await seedAttempt(stranger.email, { endpoint: false });
  await openAs(page, owner, `/agent/claim?attempt=${attempt}`);
  const panel = page.getByTestId("agent-claim");
  await expect(panel.getByRole("heading", { name: "Wrong account" })).toBeVisible({
    timeout: 15000,
  });
  await expect(panel.getByText(owner.email)).toBeVisible();
  await expect(panel.getByText(stranger.email)).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Sign in with another account" })).toBeVisible();
});

test("declines a request, and refuses an unknown link", async ({ page }) => {
  const { attempt, registrationId } = await seedAttempt(owner.email, { endpoint: false });
  await openAs(page, owner, `/agent/claim?attempt=${attempt}`);
  const panel = page.getByTestId("agent-claim");
  await panel.getByRole("button", { name: "Decline" }).click({ timeout: 15000 });
  await expect(panel.getByRole("heading", { name: "Request declined" })).toBeVisible();
  const { data } = await admin
    .from("agent_registrations")
    .select("attempt_denied_at")
    .eq("id", registrationId)
    .single();
  expect(data?.attempt_denied_at).not.toBeNull();

  await page.goto(`/agent/claim?attempt=cat_${"x".repeat(32)}`);
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible({
    timeout: 15000,
  });
});

test("lists connected agents in Account and disconnects one", async ({ page }) => {
  const { data, error } = await admin
    .from("agent_registrations")
    .insert({
      kind: "anonymous",
      client_name: "Account list agent",
      user_id: stranger.id,
      claimed_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  registrationIds.push(data.id);

  await openAs(page, stranger, "/account");
  const list = page.getByTestId("connected-agents");
  await expect(list.getByText("Account list agent")).toBeVisible({ timeout: 15000 });
  await list.getByRole("button", { name: "Disconnect agent" }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(list.getByText("No agents connected.")).toBeVisible();
  const { data: row } = await admin
    .from("agent_registrations")
    .select("revoked_at")
    .eq("id", data.id)
    .single();
  expect(row?.revoked_at).not.toBeNull();
});
