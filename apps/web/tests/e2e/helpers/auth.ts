import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://192.168.0.247:8000";
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
 * Sign in a test user by calling signInWithPassword in the browser context.
 * This uses the actual Supabase client in the browser, which correctly sets
 * cookies via @supabase/ssr — no manual cookie manipulation needed.
 */
export async function signInTestUser(
  page: Page,
  testUser: TestUser,
  targetPath = "/account"
): Promise<void> {
  // Navigate to any page first so we're on the correct origin
  await page.goto("/login");
  await page.waitForLoadState("domcontentloaded");

  // Call signInWithPassword inside the browser via the Supabase client.
  // The @supabase/ssr createBrowserClient handles cookie storage automatically.
  await page.evaluate(
    async ({ email, password, supabaseUrl, anonKey }) => {
      // Dynamic import to use the browser-bundled Supabase client
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(supabaseUrl, anonKey);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(`signInWithPassword failed: ${error.message}`);
    },
    {
      email: testUser.email,
      password: testUser.password,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? SUPABASE_URL,
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY!,
    }
  );

  // Navigate to target — the middleware will refresh the session from cookies
  await page.goto(targetPath);
  await page.waitForLoadState("networkidle");
}
