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
 * Saves the choice on the account. Returns whether it changed, so an answer
 * repeated from another browser leaves no audit row.
 */
export async function setAccountAnalyticsConsent(
  userId: string,
  consent: AccountAnalyticsConsent
): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("users")
    .update({ analytics_consent: consent, analytics_consent_at: new Date().toISOString() })
    .eq("id", userId)
    .or(`analytics_consent.is.null,analytics_consent.neq.${consent}`)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
