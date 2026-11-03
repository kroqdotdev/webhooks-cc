import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  getAccountAnalyticsConsent,
  setAccountAnalyticsConsent,
} from "@/lib/supabase/analytics-consent";

/**
 * The analytics choice on the account (migration 00082): every save moves
 * the time (a browser's unsent choice is compared with it), only a change
 * reports as one (a repeat leaves no audit row), and the CHECK refuses
 * anything but granted or denied.
 */

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required");

const admin = createClient(process.env.SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];

afterAll(async () => {
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function account(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `test-analytics-consent-${Date.now()}@webhooks-test.local`,
    password: "TestPassword123!",
    email_confirm: true,
  });
  if (error) throw error;
  userIds.push(data.user!.id);
  return data.user!.id;
}

describe("account analytics consent", () => {
  it("saves a change, times a repeat without reporting it, refuses other values", async () => {
    const userId = await account();
    await expect(getAccountAnalyticsConsent(userId)).resolves.toEqual({
      consent: null,
      savedAt: null,
    });

    expect(await setAccountAnalyticsConsent(userId, "granted")).toBe(true);
    const first = await getAccountAnalyticsConsent(userId);
    expect(first.consent).toBe("granted");
    expect(first.savedAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await setAccountAnalyticsConsent(userId, "granted")).toBe(false);
    const repeat = await getAccountAnalyticsConsent(userId);
    expect(repeat.consent).toBe("granted");
    expect(Date.parse(repeat.savedAt!)).toBeGreaterThan(Date.parse(first.savedAt!));

    expect(await setAccountAnalyticsConsent(userId, "denied")).toBe(true);
    expect((await getAccountAnalyticsConsent(userId)).consent).toBe("denied");

    const { error } = await admin
      .from("users")
      .update({ analytics_consent: "maybe" as never })
      .eq("id", userId);
    expect(error?.code).toBe("23514");
  });
});
