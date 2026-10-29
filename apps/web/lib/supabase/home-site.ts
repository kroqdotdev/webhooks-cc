import { reportError } from "@/lib/observability";
import { parseSite, siteOrigin, type SiteKey } from "@/lib/site";
import { createAdminClient } from "./admin";

/**
 * Records the site a person signed in on (users.home_site), so emails sent
 * outside a request link where their session is. Best effort: a sign-in
 * never fails over it.
 */
export async function rememberHomeSite(userId: string, site: SiteKey): Promise<void> {
  try {
    const { error } = await createAdminClient()
      .from("users")
      .update({ home_site: site })
      .eq("id", userId)
      .neq("home_site", site);
    if (error) throw error;
  } catch (error) {
    reportError("[site] could not record the account's site", error);
  }
}

/** The origin an account's emails link to. */
export function homeOrigin(homeSite: string | null | undefined): string {
  return siteOrigin(parseSite(homeSite));
}
