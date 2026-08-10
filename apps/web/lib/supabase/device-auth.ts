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
  const code = await findDeviceCodeByCode(deviceCode);

  if (!code) {
    throw new Error("Invalid or expired code");
  }
  if (isExpired(code.expires_at)) {
    throw new Error("Code expired");
  }
  if (code.status !== "authorized") {
    throw new Error("Code not yet authorized");
  }
  if (!code.user_id) {
    throw new Error("Code not properly authorized");
  }

  const { count, error: countError } = await admin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", code.user_id);

  if (countError) {
    throw countError;
  }

  if ((count ?? 0) >= MAX_KEYS_PER_USER) {
    // Every CLI login mints a fresh key and `whk auth logout` only clears the
    // local token, so repeat logins accumulate device-auth keys until every
    // claim fails and the user is locked out. Rotate the oldest device-auth
    // keys to make room; manually created keys are never touched.
    const excess = (count ?? 0) - MAX_KEYS_PER_USER + 1;
    const { data: rotatable, error: rotatableError } = await admin
      .from("api_keys")
      .select("id")
      .eq("user_id", code.user_id)
      .eq("name", DEVICE_AUTH_KEY_NAME)
      .order("created_at", { ascending: true })
      .limit(excess);

    if (rotatableError) {
      throw rotatableError;
    }
    if ((rotatable?.length ?? 0) < excess) {
      throw new Error(`Maximum of ${MAX_KEYS_PER_USER} API keys allowed per user`);
    }

    const { error: rotateError } = await admin
      .from("api_keys")
      .delete()
      .in(
        "id",
        rotatable.map((key) => key.id)
      );

    if (rotateError) {
      throw rotateError;
    }
  }

  const { data: consumedCode, error: consumeError } = await admin
    .from("device_codes")
    .delete()
    .eq("id", code.id)
    .eq("status", "authorized")
    .eq("user_id", code.user_id)
    .select("id")
    .maybeSingle();

  if (consumeError) {
    throw consumeError;
  }
  if (!consumedCode) {
    throw new Error("Invalid or already claimed code");
  }

  const rawKey = generateApiKey();
  const { error: insertError } = await admin.from("api_keys").insert({
    user_id: code.user_id,
    key_hash: hashApiKey(rawKey),
    key_prefix: rawKey.slice(0, 12),
    name: DEVICE_AUTH_KEY_NAME,
    expires_at: new Date(Date.now() + API_KEY_TTL_MS).toISOString(),
  });

  if (insertError) {
    throw insertError;
  }

  const { data: user, error: userError } = await admin
    .from("users")
    .select("email")
    .eq("id", code.user_id)
    .maybeSingle();

  if (userError) {
    throw userError;
  }

  return {
    apiKey: rawKey,
    userId: code.user_id,
    email: user?.email ?? "",
  };
}
