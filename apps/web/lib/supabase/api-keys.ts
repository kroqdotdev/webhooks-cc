import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { createAdminClient } from "./admin";

export type UserPlan = "free" | "pro";
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
    .select("id, user_id, expires_at, is_agent_issued, scopes")
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
      console.error("Failed to update api_keys.last_used_at:", updateError);
    }

    return {
      userId: null,
      plan: "free",
      isAgentIssued: true,
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
    isAgentIssued: keyRow.is_agent_issued ?? false,
  };
}
