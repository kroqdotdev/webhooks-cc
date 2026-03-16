import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  authorizeDeviceCodeForUser,
  claimDeviceCode,
  createDeviceCodeRecord,
  pollDeviceCodeStatus,
} from "@/lib/supabase/device-auth";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TEST_EMAIL = `test-device-auth-${Date.now()}@webhooks-test.local`;
const TEST_PASSWORD = "TestPassword123!";

let testUserId: string;

describe("Supabase Device Auth Integration", () => {
  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: "Device Auth Test User",
      },
    });

    if (error) {
      throw error;
    }

    testUserId = data.user!.id;
  });

  afterAll(async () => {
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
    }
  });

  it("creates, authorizes, polls, and claims a device code", async () => {
    const created = await createDeviceCodeRecord();
    expect(created.deviceCode).toHaveLength(32);
    expect(created.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(created.expiresAt).toBeGreaterThan(Date.now());

    const pending = await pollDeviceCodeStatus(created.deviceCode);
    expect(pending).toEqual({ status: "pending" });

    const authorized = await authorizeDeviceCodeForUser(testUserId, created.userCode);
    expect(authorized).toEqual({
      success: true,
      email: TEST_EMAIL,
    });

    const afterAuthorize = await pollDeviceCodeStatus(created.deviceCode);
    expect(afterAuthorize).toEqual({ status: "authorized" });

    const claimed = await claimDeviceCode(created.deviceCode);
    expect(claimed.userId).toBe(testUserId);
    expect(claimed.email).toBe(TEST_EMAIL);
    expect(claimed.apiKey.startsWith("whcc_")).toBe(true);

    const afterClaim = await pollDeviceCodeStatus(created.deviceCode);
    expect(afterClaim).toEqual({ status: "expired" });
  });
});
