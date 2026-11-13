import { customAlphabet } from "nanoid";
import { createAdminClient } from "./admin";
import { generateApiKey, hashApiKey, MAX_KEYS_PER_USER } from "./api-keys";
import { compareNetworks, type DeviceRequester, type NetworkMatch } from "@/lib/device-requester";

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
  status: "pending" | "authorized" | "denied" | "expired";
}

/** A pending login as its approval page shows it. */
export interface DeviceLoginRequest {
  userCode: string;
  client: string | null;
  country: string | null;
  remote: boolean;
  /** The approving browser's network against the requester's. */
  network: NetworkMatch;
  createdAt: number;
  expiresAt: number;
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
  status: "pending" | "authorized" | "denied";
  user_id: string | null;
  client: string | null;
  country: string | null;
  network: string | null;
  remote: boolean;
  created_at: string;
};

const ROW_COLUMNS =
  "id, device_code, user_code, expires_at, status, user_id, client, country, network, remote, created_at";

function isExpired(timestamp: string): boolean {
  return new Date(timestamp).getTime() < Date.now();
}

async function findDeviceCodeByUserCode(userCode: string): Promise<DeviceCodeRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("device_codes")
    .select(ROW_COLUMNS)
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
    .select(ROW_COLUMNS)
    .eq("device_code", deviceCode)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function createDeviceCodeRecord(
  requester?: DeviceRequester
): Promise<DeviceCodeRecord> {
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
    client: requester?.client ?? null,
    country: requester?.country ?? null,
    network: requester?.network ?? null,
    remote: requester?.remote ?? false,
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
  if (code.status !== "pending") {
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

/**
 * The pending login behind a user code, for its approval page; null when
 * there is none, it expired or it was answered already.
 */
export async function describeDeviceCode(
  userCode: string,
  approverNetwork: string | null
): Promise<DeviceLoginRequest | null> {
  const code = await findDeviceCodeByUserCode(userCode);
  if (!code || code.status !== "pending" || isExpired(code.expires_at)) return null;
  return {
    userCode: code.user_code,
    client: code.client,
    country: code.country,
    remote: code.remote,
    network: compareNetworks(code.network, approverNetwork),
    createdAt: new Date(code.created_at).getTime(),
    expiresAt: new Date(code.expires_at).getTime(),
  };
}

/**
 * Refuses a pending login ("This wasn't me"): the client's next poll
 * answers denied and it stops, instead of waiting for the code to expire.
 */
export async function denyDeviceCode(userCode: string): Promise<void> {
  const admin = createAdminClient();
  const code = await findDeviceCodeByUserCode(userCode);
  if (!code) throw new Error("Invalid code");
  if (isExpired(code.expires_at)) throw new Error("Code expired");
  const { data, error } = await admin
    .from("device_codes")
    .update({ status: "denied" })
    .eq("id", code.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Code already used");
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
