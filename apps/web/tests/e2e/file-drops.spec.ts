import { readFileSync } from "node:fs";
import net from "node:net";
import { test, expect, type Page } from "@playwright/test";
import {
  admin,
  createTestUser,
  deleteTestUser,
  signInTestUser,
  type TestUser,
} from "./helpers/auth";

/**
 * File drop destinations in the dashboard (migration 00074): a Business
 * account adds one for its SFTP server, tests the connection (which pins
 * the host key and writes a test file), and the secret is never shown back;
 * changing the server asks for it again. Needs the SFTP test server (see
 * tests/integration/file-drop-servers.test.ts) and the dev server with
 * FORWARDING_ALLOW_PRIVATE_TARGETS=true; skipped without the server.
 */

const PASSWORD = (() => {
  try {
    return readFileSync("/tmp/whdev/drops/test-password", "utf8").trim();
  } catch {
    return process.env.DROP_TEST_PASSWORD ?? "";
  }
})();

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

let user: TestUser;
let endpointId: string;
let endpointSlug: string;

test.beforeAll(async () => {
  user = await createTestUser();
  await admin
    .from("users")
    .update({
      plan: "business",
      subscription_status: "active",
      period_end: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    })
    .eq("id", user.id);
  const { data, error } = await admin
    .from("endpoints")
    .insert({ slug: `e2e-drops-${Date.now()}`, name: "Drops E2E", user_id: user.id })
    .select("id, slug")
    .single();
  if (error) throw error;
  endpointId = data.id;
  endpointSlug = data.slug;
});

test.afterAll(async () => {
  if (endpointId) {
    await admin
      .from("endpoint_destinations")
      .update({ enabled: false })
      .eq("endpoint_id", endpointId);
    await admin.from("endpoints").delete().eq("id", endpointId);
  }
  if (user) await deleteTestUser(user.id);
});

async function openForwarding(page: Page) {
  await signInTestUser(page, user, `/dashboard?endpoint=${endpointSlug}`);
  await expect(page.locator("span.font-bold.caps", { hasText: "Drops E2E" })).toBeVisible({
    timeout: 15000,
  });
  await page
    .getByRole("navigation", { name: "Endpoint" })
    .getByRole("button", { name: "Settings" })
    .click();
  const section = page.getByRole("region", { name: "Forwarding" });
  await expect(section).toBeVisible();
  return section;
}

test("a Business account adds an SFTP drop, tests it, and the password stays hidden", async ({
  page,
}) => {
  test.skip(!PASSWORD || !(await reachable(2222)), "the SFTP test server is not running");
  const section = await openForwarding(page);
  await section.getByRole("button", { name: /^File drop/ }).click();

  await section.getByLabel("Name", { exact: true }).fill("Orders to the ERP");
  await expect(section.getByRole("radio", { name: "SFTP" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await section.getByLabel("Host", { exact: true }).fill("127.0.0.1");
  await section.getByLabel("Port", { exact: true }).fill("2222");
  await section.getByLabel("Username", { exact: true }).fill("acme");
  await section.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await section.getByLabel("Folder", { exact: true }).fill("upload");
  await section.getByRole("radio", { name: "A file per batch" }).click();
  await section.getByLabel("Collect for").fill("5");
  await section.getByLabel("File name prefix").fill("orders-");
  await section.getByRole("button", { name: "Add destination" }).click();

  // Saved: the row opens again with its editor; the password is not sent back.
  await expect(section.getByLabel("Password", { exact: true })).toHaveValue("", { timeout: 10000 });
  await expect(section.getByLabel("Password", { exact: true })).toHaveAttribute(
    "placeholder",
    "Saved"
  );
  const { data: row } = await admin
    .from("endpoint_destinations")
    .select("format, delay_seconds, config, drop_secret_encrypted, url")
    .eq("endpoint_id", endpointId)
    .single();
  expect(row).toMatchObject({ format: "file_drop", delay_seconds: 300 });
  expect(row?.drop_secret_encrypted).toBeTruthy();
  expect(JSON.stringify(row?.config)).not.toContain(PASSWORD);
  expect(row?.url).toBe("sftp://127.0.0.1:2222/upload");

  await section.getByRole("button", { name: "Test the connection" }).click();
  await expect(section.getByText("Connected and wrote upload/webhooks-cc-test.txt.")).toBeVisible({
    timeout: 20000,
  });
  await expect(section.getByText(/^Host key:/)).toBeVisible();

  // Another server needs the password again.
  await section.getByLabel("Host", { exact: true }).fill("localhost");
  await section.getByRole("button", { name: "Save destination" }).click();
  await expect(
    section.getByText("Enter the password or key again: the drop now goes to another server.")
  ).toBeVisible();
});

test("a Pro account cannot save a drop", async ({ page }) => {
  await admin.from("users").update({ plan: "pro" }).eq("id", user.id);
  await admin.from("endpoint_destinations").delete().eq("endpoint_id", endpointId);
  try {
    const section = await openForwarding(page);
    await section.getByRole("button", { name: /^File drop/ }).click();
    await section.getByLabel("Host", { exact: true }).fill("files.acme.example");
    await section.getByLabel("Username", { exact: true }).fill("acme");
    await section.getByLabel("Password", { exact: true }).fill("secret-value");
    await section.getByRole("button", { name: "Add destination" }).click();
    await expect(section.getByText("File drops are part of Business.")).toBeVisible({
      timeout: 10000,
    });
  } finally {
    await admin.from("users").update({ plan: "business" }).eq("id", user.id);
  }
});
