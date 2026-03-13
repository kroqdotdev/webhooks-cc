import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { createAdminClient } from "./admin";
import type { Database } from "./database";

export type UserPlan = "free" | "pro";
export const MAX_KEYS_PER_USER = 10;

const generateApiKeyBody = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);

type ApiKeyRow = Database["public"]["Tables"]["api_keys"]["Row"];
type UserRow = Database["public"]["Tables"]["users"]["Row"];

export interface ApiKeyValidationResult {
  userId: string;
  plan: UserPlan;
}

export function generateApiKey(): string {
  return `whcc_${generateApiKeyBody()}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function isExpired(timestamp: string | null): boolean {
  if (!timestamp) return false;
  return new Date(timestamp).getTime() < Date.now();
}

export async function validateApiKeyWithMetadata(
  apiKey: string
): Promise<ApiKeyValidationResult | null> {
  const admin = createAdminClient();
  const keyHash = hashApiKey(apiKey);

  const { data: keyRow, error: keyError } = await admin
    .from("api_keys")
    .select("id, user_id, expires_at")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (keyError) {
    throw keyError;
  }

  if (!keyRow || isExpired(keyRow.expires_at)) {
    return null;
  }

  const { data: userRow, error: userError } = await admin
    .from("users")
    .select("plan")
    .eq("id", keyRow.user_id)
    .maybeSingle();

  if (userError) {
    throw userError;
  }

  if (!userRow || (userRow.plan !== "free" && userRow.plan !== "pro")) {
    return null;
  }

  const { error: updateError } = await admin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRow.id);

  if (updateError) {
    console.error("Failed to update api_keys.last_used_at:", updateError);
  }

  return {
    userId: keyRow.user_id,
    plan: userRow.plan,
  };
}
