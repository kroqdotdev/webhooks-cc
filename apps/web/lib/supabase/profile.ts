import { createAdminClient } from "./admin";

export const DISPLAY_NAME_MAX_LENGTH = 80;

// C0 and C1 controls, line and paragraph separators, and the bidi embedding,
// override and isolate controls (which can make a name render as something
// else in member lists and invite emails). Zero-width joiners stay allowed:
// emoji sequences need them.
const FORBIDDEN_NAME_CHARS = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

export type DisplayNameParseResult =
  { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Validates the `name` field of PATCH /api/account. A string is trimmed; an
 * empty string or null clears the override.
 */
export function parseDisplayName(input: unknown): DisplayNameParseResult {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== "string") {
    return { ok: false, error: "name must be a string or null" };
  }

  const value = input.trim();
  if (value === "") return { ok: true, value: null };

  if (FORBIDDEN_NAME_CHARS.test(value)) {
    return { ok: false, error: "Name cannot contain control characters" };
  }
  if ([...value].length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer`,
    };
  }

  return { ok: true, value };
}

// The characters handle_new_user() removes from whichever name it stores
// (migration 00059): C0 and C1 controls, line and paragraph separators, bidi
// embeddings, overrides and isolates. Keep the two in step.
const STRIPPED_NAME_CHARS = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Cleans a name the way handle_new_user() does before storing it: strips
 * control and bidi characters, trims, caps at 80 characters (code points, as
 * Postgres counts them) and turns an empty result into null.
 */
export function cleanStoredName(value: string | null): string | null {
  if (value === null) return null;
  const capped = [...value.replace(STRIPPED_NAME_CHARS, "").trim()]
    .slice(0, DISPLAY_NAME_MAX_LENGTH)
    .join("");
  return capped === "" ? null : capped;
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * The name handle_new_user() derives for a user (migration 00059): a
 * non-blank display_name override from app_metadata, else the provider's
 * full_name, else its name, cleaned. Keep the two in step.
 */
export function effectiveDisplayName(appMetadata: unknown, userMetadata: unknown): string | null {
  const override = metadataString(appMetadata, "display_name")?.trim();
  return cleanStoredName(
    override || metadataString(userMetadata, "full_name") || metadataString(userMetadata, "name")
  );
}

/**
 * Stores the user's chosen name as `display_name` in their app_metadata, which
 * only the service role can write, so the checks in parseDisplayName cannot be
 * skipped through GoTrue's own updateUser. An OAuth re-login refreshes only
 * user_metadata, so the override survives it. GoTrue merges app_metadata keys
 * and deletes a key set to null, so clearing falls back to the provider name.
 *
 * Changing app_metadata does not fire handle_new_user(), so the effective name
 * is written to public.users here. Returns that name.
 */
export async function updateDisplayName(
  userId: string,
  name: string | null
): Promise<string | null> {
  const admin = createAdminClient();

  const { data, error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { display_name: name },
  });
  if (error) throw error;

  const effective = effectiveDisplayName(data.user?.app_metadata, data.user?.user_metadata);

  const { error: updateError } = await admin
    .from("users")
    .update({ name: effective })
    .eq("id", userId);
  if (updateError) throw updateError;

  return effective;
}
