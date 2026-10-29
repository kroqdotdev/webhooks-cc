import { headers } from "next/headers";
import { SITE_HEADER, parseSite, siteOrigin, type SiteKey } from "@/lib/site";

/**
 * The request's site, as proxy.ts resolved it. Reading it makes a page
 * dynamic, so only the app's own layouts (sign-in, dashboard, settings) do;
 * mailhooks.cc's marketing pages are separate routes and stay static.
 */
export async function currentSite(): Promise<SiteKey> {
  return parseSite((await headers()).get(SITE_HEADER));
}

/**
 * Where a checkout returns to: mailhooks.cc's origin for a request made
 * there, `fallback` (the app URL) otherwise, and outside a request (a
 * worker, a test). Sessions are per host, so a buyer must come back to the
 * site they started on.
 */
export async function returnOrigin(fallback: string): Promise<string> {
  try {
    return (await currentSite()) === "mailhooks" ? siteOrigin("mailhooks") : fallback;
  } catch {
    return fallback;
  }
}
