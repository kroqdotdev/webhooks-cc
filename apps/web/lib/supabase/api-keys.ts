import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { createAdminClient } from "./admin";
import { reportError } from "@/lib/observability";

import { isUserPlan, type UserPlan } from "@/lib/entitlements";
export type { UserPlan };
export const MAX_KEYS_PER_USER = 10;

const generateApiKeyBody = customAlphabet(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  32
);

export interface ApiKeyValidationResult {
  /**
   * Owning user. `null` for unowned, agent-issued (anonymous) keys that have not
   * yet been claimed. Once claimed (or for verified_email / ID-JAG flows) the key
   * is rebound to a real user and `userId` is non-null again.
   */
  userId: string | null;
  plan: UserPlan;
  /** True when the key was minted by the agent auth.md flows (may be unowned). */
  isAgentIssued?: boolean;
  /** The api_keys row. */
  keyId?: string;
  /** Set when the key is an agent access token (auth.md v0.6). */
  agentRegistrationId?: string | null;
}

export function generateApiKey(): string {
  return `whcc_${generateApiKeyBody()}`;
}

/**
 * Default advisory scopes granted to agent-issued keys (auth.md v1).
 * Scopes are stored on `api_keys.scopes` but NOT enforced at the bearer
 * boundary in v1 — they are advisory only.
 */
export function defaultAgentScopes(): string[] {
  return ["webhooks:read", "webhooks:write"];
}

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** The longest an API key may live, whoever creates it. */
export const MAX_KEY_TTL_DAYS = 365;
const KEY_NAME_MAX = 64;

export class ApiKeyLimitError extends Error {
  constructor() {
    super(`Maximum of ${MAX_KEYS_PER_USER} API keys allowed`);
    this.name = "ApiKeyLimitError";
  }
}

/** The name an API key may have, or why not. */
export function parseKeyName(
  value: unknown
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: "Name is required" };
  const name = value
    // eslint-disable-next-line no-control-regex -- removing them is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return { ok: false, error: "Name is required" };
  if (name.length > KEY_NAME_MAX) {
    return { ok: false, error: `Keep the name under ${KEY_NAME_MAX} characters` };
  }
  return { ok: true, name };
}

export interface CreatedApiKey {
  /** The key itself; shown once, never stored. */
  key: string;
  name: string;
  keyPrefix: string;
  expiresAt: string;
}

/**
 * Creates an API key for an account: the account's own keys (not agent
 * tokens) count against MAX_KEYS_PER_USER. Throws ApiKeyLimitError at the cap.
 */
export async function createApiKeyForUser(
  userId: string,
  name: string,
  ttlDays: number
): Promise<CreatedApiKey> {
  const admin = createAdminClient();
  const { count, error: countError } = await admin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("agent_registration_id", null);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_KEYS_PER_USER) throw new ApiKeyLimitError();

  const key = generateApiKey();
  const keyPrefix = key.slice(0, 12);
  const days = Math.min(Math.max(Math.floor(ttlDays), 1), MAX_KEY_TTL_DAYS);
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const { error } = await admin.from("api_keys").insert({
    user_id: userId,
    name,
    key_hash: hashApiKey(key),
    key_prefix: keyPrefix,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return { key, name, keyPrefix, expiresAt };
}

function isExpired(timestamp: string | null): boolean {
  if (!timestamp) return false;
  return new Date(timestamp).getTime() < Date.now();
}

export async function validateApiKeyWithMetadata(
  apiKey: string
): Promise<ApiKeyValidationResult | null> {
  // AUDIT — null-user (unowned agent) key consumers of `userId`:
  //   - api-auth.ts: returns `userId` from validation; widening to `string | null`
  //     is consumed there (owned by task F3, not edited here).
  //   - API routes: key rate limits on `endpoint-create:${userId}` and write
  //     request-ownership rows keyed on `userId`. A null userId here would weaken
  //     per-user rate limiting and ownership — which is why anonymous agent keys
  //     are short-lived and claimed quickly (rebound to a real user on claim).
  //   - Receiver capture path: does NOT read `api_keys` (it authenticates by
  //     endpoint slug, not bearer key), so it is unaffected by unowned keys.
  const admin = createAdminClient();
  const keyHash = hashApiKey(apiKey);

  const { data: keyRow, error: keyError } = await admin
    .from("api_keys")
    .select("id, user_id, expires_at, is_agent_issued, scopes, agent_registration_id")
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (keyError) {
    throw keyError;
  }

  if (!keyRow || isExpired(keyRow.expires_at)) {
    return null;
  }

  // Unowned agent-issued key (user_id NULL): valid, but not yet bound to a user.
  // Do NOT join `users`; grant the default agent plan and still record usage.
  if (keyRow.user_id === null) {
    const { error: updateError } = await admin
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", keyRow.id);

    if (updateError) {
      reportError("Failed to update api_keys.last_used_at", updateError);
    }

    return {
      userId: null,
      plan: "free",
      isAgentIssued: true,
      keyId: keyRow.id,
      agentRegistrationId: keyRow.agent_registration_id,
    };
  }

  // Owned key: keep the existing users.plan join + null-on-missing-plan behavior.
  const { data: userRow, error: userError } = await admin
    .from("users")
    .select("plan")
    .eq("id", keyRow.user_id)
    .maybeSingle();

  if (userError) {
    throw userError;
  }

  if (!userRow || !isUserPlan(userRow.plan)) {
    return null;
  }

  const { error: updateError } = await admin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRow.id);

  if (updateError) {
    reportError("Failed to update api_keys.last_used_at", updateError);
  }

  return {
    userId: keyRow.user_id,
    plan: userRow.plan,
    isAgentIssued: keyRow.is_agent_issued ?? false,
    keyId: keyRow.id,
    agentRegistrationId: keyRow.agent_registration_id,
  };
}
