import { customAlphabet } from "nanoid";
import { createAdminClient } from "./admin";
import { generateApiKey, hashApiKey, MAX_KEYS_PER_USER } from "./api-keys";

const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;
const API_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PENDING_CODES = 500;
export const DEVICE_AUTH_KEY_NAME = "CLI (device auth)";

const generateDeviceCode = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);
const generateUserCodePart = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 4);

export interface DeviceCodeRecord {
  deviceCode: string;
  userCode: string;
  expiresAt: number;
}

export interface DeviceCodeStatus {
  status: "pending" | "authorized" | "expired";
}

export interface AuthorizedDeviceCode {
  success: true;
  email: string | null;
}

export interface ClaimedDeviceCode {
  apiKey: string;
  userId: string;
  email: string;
}

type DeviceCodeRow = {
  id: string;
  device_code: string;
  user_code: string;
  expires_at: string;
  status: "pending" | "authorized";
  user_id: string | null;
};

function isExpired(timestamp: string): boolean {
  return new Date(timestamp).getTime() < Date.now();
}

async function findDeviceCodeByUserCode(userCode: string): Promise<DeviceCodeRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("device_codes")
    .select("id, device_code, user_code, expires_at, status, user_id")
    .eq("user_code", userCode.toUpperCase())
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function findDeviceCodeByCode(deviceCode: string): Promise<DeviceCodeRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("device_codes")
    .select("id, device_code, user_code, expires_at, status, user_id")
    .eq("device_code", deviceCode)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function createDeviceCodeRecord(): Promise<DeviceCodeRecord> {
  const admin = createAdminClient();
  const { count, error: countError } = await admin
    .from("device_codes")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  if (countError) {
    throw countError;
  }

  if ((count ?? 0) > MAX_PENDING_CODES) {
    throw new Error("Too many pending device codes, please try again later");
  }

  const deviceCode = generateDeviceCode();
  const userCode = `${generateUserCodePart()}-${generateUserCodePart()}`;
  const expiresAt = Date.now() + DEVICE_CODE_TTL_MS;

  const { error } = await admin.from("device_codes").insert({
    device_code: deviceCode,
    user_code: userCode,
    expires_at: new Date(expiresAt).toISOString(),
  });

  if (error) {
    throw error;
  }

  return {
    deviceCode,
    userCode,
    expiresAt,
  };
}

export async function pollDeviceCodeStatus(deviceCode: string): Promise<DeviceCodeStatus> {
  const code = await findDeviceCodeByCode(deviceCode);

  if (!code || isExpired(code.expires_at)) {
    return { status: "expired" };
  }

  return { status: code.status };
}

export async function authorizeDeviceCodeForUser(
  userId: string,
  userCode: string
): Promise<AuthorizedDeviceCode> {
  const admin = createAdminClient();
  const code = await findDeviceCodeByUserCode(userCode);

  if (!code) {
    throw new Error("Invalid code");
  }
  if (isExpired(code.expires_at)) {
    throw new Error("Code expired");
  }
  if (code.status === "authorized") {
    throw new Error("Code already used");
  }

  const { data: user, error: userError } = await admin
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  if (userError) {
    throw userError;
  }

  const { data: updatedCode, error: updateError } = await admin
    .from("device_codes")
    .update({
      status: "authorized",
      user_id: userId,
    })
    .eq("id", code.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (updateError) {
    throw updateError;
  }
  if (!updatedCode) {
    throw new Error("Code already used");
  }

  return {
    success: true,
    email: user?.email ?? null,
  };
}

export async function claimDeviceCode(deviceCode: string): Promise<ClaimedDeviceCode> {
  const admin = createAdminClient();
  const rawKey = generateApiKey();

  // The whole claim runs in one transaction: at the key cap it rotates the
  // oldest device-auth keys (is_device_auth flag, never the display name —
  // manually created keys are never touched), consumes the device code, and
  // mints the new key, serialized per user. Rotation exists because every CLI
  // login mints a fresh key while `whk auth logout` only clears the local
  // token, so repeat logins would otherwise lock the user out at the cap.
  const { data, error } = await admin.rpc("claim_device_code", {
    p_device_code: deviceCode,
    p_key_hash: hashApiKey(rawKey),
    p_key_prefix: rawKey.slice(0, 12),
    p_key_name: DEVICE_AUTH_KEY_NAME,
    p_key_expires_at: new Date(Date.now() + API_KEY_TTL_MS).toISOString(),
    p_max_keys: MAX_KEYS_PER_USER,
  });

  if (error) {
    throw error;
  }

  const result = data as {
    status: "ok" | "invalid" | "expired" | "not_authorized" | "key_limit";
    user_id?: string;
    email?: string | null;
  };

  switch (result.status) {
    case "ok":
      return {
        apiKey: rawKey,
        userId: result.user_id!,
        email: result.email ?? "",
      };
    case "expired":
      throw new Error("Code expired");
    case "not_authorized":
      throw new Error("Code not yet authorized");
    case "key_limit":
      throw new Error(`Maximum of ${MAX_KEYS_PER_USER} API keys allowed per user`);
    default:
      throw new Error("Invalid or expired code");
  }
}
