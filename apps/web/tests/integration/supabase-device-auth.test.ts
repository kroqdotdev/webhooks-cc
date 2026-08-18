import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  authorizeDeviceCodeForUser,
  claimDeviceCode,
  createDeviceCodeRecord,
  DEVICE_AUTH_KEY_NAME,
  pollDeviceCodeStatus,
} from "@/lib/supabase/device-auth";
import { generateApiKey, hashApiKey, MAX_KEYS_PER_USER } from "@/lib/supabase/api-keys";

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

  describe("API key cap", () => {
    afterEach(async () => {
      await admin.from("api_keys").delete().eq("user_id", testUserId);
    });

    async function seedKeys(name: string, count: number, isDeviceAuth = false) {
      // Staggered created_at so "oldest" is deterministic
      const base = Date.now() - count * 60_000;
      const rows = Array.from({ length: count }, (_, i) => {
        const raw = generateApiKey();
        return {
          user_id: testUserId,
          key_hash: hashApiKey(raw),
          key_prefix: raw.slice(0, 12),
          name,
          is_device_auth: isDeviceAuth,
          created_at: new Date(base + i * 60_000).toISOString(),
        };
      });
      const { data, error } = await admin.from("api_keys").insert(rows).select("id");
      if (error) throw error;
      return data.map((row) => row.id as string);
    }

    async function authorizedDeviceCode() {
      const created = await createDeviceCodeRecord();
      await authorizeDeviceCodeForUser(testUserId, created.userCode);
      return created.deviceCode;
    }

    it("rotates the oldest device-auth key when the user is at the cap", async () => {
      const seededIds = await seedKeys(DEVICE_AUTH_KEY_NAME, MAX_KEYS_PER_USER, true);
      const oldestId = seededIds[0];

      const claimed = await claimDeviceCode(await authorizedDeviceCode());
      expect(claimed.apiKey.startsWith("whcc_")).toBe(true);

      const { data: remaining } = await admin
        .from("api_keys")
        .select("id")
        .eq("user_id", testUserId);
      expect(remaining).toHaveLength(MAX_KEYS_PER_USER);
      expect(remaining!.map((row) => row.id)).not.toContain(oldestId);
    });

    it("never rotates manually created keys", async () => {
      await seedKeys("CI deploy key", MAX_KEYS_PER_USER);

      await expect(claimDeviceCode(await authorizedDeviceCode())).rejects.toThrow(
        /Maximum of \d+ API keys/
      );

      const { count } = await admin
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("user_id", testUserId);
      expect(count).toBe(MAX_KEYS_PER_USER);
    });

    it("rotates only device-auth keys in a mixed set", async () => {
      const manualIds = await seedKeys("CI deploy key", MAX_KEYS_PER_USER - 1);
      const [deviceKeyId] = await seedKeys(DEVICE_AUTH_KEY_NAME, 1, true);

      const claimed = await claimDeviceCode(await authorizedDeviceCode());
      expect(claimed.apiKey.startsWith("whcc_")).toBe(true);

      const { data: remaining } = await admin
        .from("api_keys")
        .select("id")
        .eq("user_id", testUserId);
      const remainingIds = remaining!.map((row) => row.id);
      expect(remainingIds).not.toContain(deviceKeyId);
      for (const id of manualIds) {
        expect(remainingIds).toContain(id);
      }
    });

    it("never rotates a manual key that merely shares the device-auth display name", async () => {
      // Rotation eligibility is the is_device_auth flag, not the display name
      // — /api/api-keys accepts arbitrary names, including this one.
      await seedKeys(DEVICE_AUTH_KEY_NAME, MAX_KEYS_PER_USER, false);

      await expect(claimDeviceCode(await authorizedDeviceCode())).rejects.toThrow(
        /Maximum of \d+ API keys/
      );

      const { count } = await admin
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("user_id", testUserId);
      expect(count).toBe(MAX_KEYS_PER_USER);
    });

    it("holds the cap under concurrent claims", async () => {
      const seededIds = await seedKeys(DEVICE_AUTH_KEY_NAME, MAX_KEYS_PER_USER, true);

      const [codeA, codeB] = await Promise.all([authorizedDeviceCode(), authorizedDeviceCode()]);
      const results = await Promise.allSettled([claimDeviceCode(codeA), claimDeviceCode(codeB)]);

      // Serialized claims each rotate one key: both succeed, cap never exceeded
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

      const { data: remaining } = await admin
        .from("api_keys")
        .select("id")
        .eq("user_id", testUserId);
      expect(remaining).toHaveLength(MAX_KEYS_PER_USER);

      const remainingIds = remaining!.map((row) => row.id);
      expect(remainingIds).not.toContain(seededIds[0]);
      expect(remainingIds).not.toContain(seededIds[1]);
    });
  });
});
