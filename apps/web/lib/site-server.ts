import { headers } from "next/headers";
import { SITE_HEADER, parseSite, type SiteKey } from "@/lib/site";

/**
 * The request's site, as proxy.ts resolved it. Reading it makes a page
 * dynamic, so only the app's own layouts (sign-in, dashboard, settings) do;
 * mailhooks.cc's marketing pages are separate routes and stay static.
 */
export async function currentSite(): Promise<SiteKey> {
  return parseSite((await headers()).get(SITE_HEADER));
}
