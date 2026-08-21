import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export async function createTestUser(): Promise<TestUser> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@webhooks-test.local`;
  const password = "E2eTestPassword123!";

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: "E2E Test User",
      avatar_url: "https://example.com/e2e-avatar.png",
    },
  });

  if (error) throw new Error(`Failed to create test user: ${error.message}`);

  return { id: data.user!.id, email, password };
}

export async function deleteTestUser(userId: string): Promise<void> {
  await admin.auth.admin.deleteUser(userId);
}

/**
 * Resolve the auth user id for an account created through the UI (sign-up
 * form), via the public.users row the handle_new_user trigger writes at
 * signup, so the spec can clean it up.
 */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const { data } = await admin.from("users").select("id").eq("email", email).maybeSingle();
  return data?.id ?? null;
}

/**
 * Mint a recovery token hash without sending mail, for driving /auth/confirm
 * directly. `properties.hashed_token` is what our email templates carry; the
 * returned action_link points at GoTrue's own verify endpoint, which the app
 * deliberately bypasses.
 */
export async function generateRecoveryTokenHash(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  return data.properties!.hashed_token;
}

/** Magic-link token hash: verifies under `type=email`, like a signup confirmation. */
export async function generateMagicLinkTokenHash(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  return data.properties!.hashed_token;
}

/**
 * Sign in a test user by calling signInWithPassword via the Supabase REST API
 * from Node.js, then injecting the session tokens into the browser via cookies
 * and localStorage so the app picks them up.
 */
export async function signInTestUser(
  page: Page,
  testUser: TestUser,
  targetPath = "/account"
): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY!;

  // Sign in via Node.js Supabase client to get tokens
  const { createClient: createNodeClient } = await import("@supabase/supabase-js");
  const nodeClient = createNodeClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await nodeClient.auth.signInWithPassword({
    email: testUser.email,
    password: testUser.password,
  });
  if (error) throw new Error(`signInWithPassword failed: ${error.message}`);

  const session = data.session!;
  // Navigate to any page to establish the correct origin
  await page.goto("/login");
  await page.waitForLoadState("domcontentloaded");

  // Set Supabase auth cookies that @supabase/ssr expects.
  // The cookie name follows the pattern: sb-<project-ref>-auth-token
  // For self-hosted, project ref is extracted from the URL hostname.
  const url = new URL(supabaseUrl);
  const projectRef = url.hostname.split(".")[0];
  const cookieBase = `sb-${projectRef}-auth-token`;

  // @supabase/ssr stores the session as chunked cookies
  const sessionPayload = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: session.token_type,
    user: session.user,
  });

  // Set the session cookie on the app's domain
  await page.context().addCookies([
    {
      name: `${cookieBase}.0`,
      value: `base64-${Buffer.from(sessionPayload).toString("base64")}`,
      domain: "localhost",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  // Navigate to target — the middleware will read the session from cookies
  await page.goto(targetPath);
  await page.waitForLoadState("networkidle");
}
