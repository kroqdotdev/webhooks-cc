import { createAdminClient } from "./admin";

/** The cookie banner choice as an account keeps it (users.analytics_consent). */
export type AccountAnalyticsConsent = "granted" | "denied";

export function parseAccountAnalyticsConsent(value: unknown): AccountAnalyticsConsent | null {
  return value === "granted" || value === "denied" ? value : null;
}

/** The account's saved choice and when it was saved, both null until one is. */
export async function getAccountAnalyticsConsent(
  userId: string
): Promise<{ consent: AccountAnalyticsConsent | null; savedAt: string | null }> {
  const { data, error } = await createAdminClient()
    .from("users")
    .select("analytics_consent, analytics_consent_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  const consent = parseAccountAnalyticsConsent(data?.analytics_consent);
  return { consent, savedAt: consent ? (data?.analytics_consent_at ?? null) : null };
}

/**
 * Saves the choice on the account. The time always moves, a repeat included:
 * it is when the account was last told, which a browser compares its own
 * unsent choice with. Returns whether the choice itself changed, so an answer
 * repeated from another browser leaves no audit row.
 */
export async function setAccountAnalyticsConsent(
  userId: string,
  consent: AccountAnalyticsConsent
): Promise<boolean> {
  const admin = createAdminClient();
  const { data: before, error: readError } = await admin
    .from("users")
    .select("analytics_consent")
    .eq("id", userId)
    .maybeSingle();
  if (readError) throw readError;
  const { error } = await admin
    .from("users")
    .update({ analytics_consent: consent, analytics_consent_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;
  return before?.analytics_consent !== consent;
}
