import { createAdminClient } from "./admin";

/**
 * Favourite endpoints (migration 00079): per person, so a team-shared
 * endpoint can be one member's favourite and not another's. Callers check
 * access first; a favourite of an endpoint the person can no longer open is
 * kept but never shown, since every read goes through their endpoints.
 */

/** The ids of every endpoint the person marked, whether or not they can open it now. */
export async function listFavoriteEndpointIds(userId: string): Promise<Set<string>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoint_favorites")
    .select("endpoint_id")
    .eq("user_id", userId);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.endpoint_id));
}

export async function isFavoriteEndpoint(userId: string, endpointId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("endpoint_favorites")
    .select("endpoint_id")
    .eq("user_id", userId)
    .eq("endpoint_id", endpointId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Marks or unmarks; either way it is idempotent. */
export async function setFavoriteEndpoint(
  userId: string,
  endpointId: string,
  favorite: boolean
): Promise<void> {
  const admin = createAdminClient();
  const { error } = favorite
    ? await admin
        .from("endpoint_favorites")
        .upsert(
          { user_id: userId, endpoint_id: endpointId },
          { onConflict: "user_id,endpoint_id", ignoreDuplicates: true }
        )
    : await admin
        .from("endpoint_favorites")
        .delete()
        .eq("user_id", userId)
        .eq("endpoint_id", endpointId);
  if (error) throw error;
}
