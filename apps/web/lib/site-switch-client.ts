import { analyticsConsent } from "@/lib/analytics-consent";
import { siteOrigin, type EndpointSite, type SiteKey } from "@/lib/site";

/**
 * The endpoint the dashboard has open, and the site it is listed on, so a
 * switch to the other site keeps it only where it is listed there.
 */
let openEndpoint: { slug: string; site: EndpointSite | undefined } | null = null;

/** Set by the dashboard while an endpoint is open; null when it closes. */
export function setOpenEndpoint(endpoint: typeof openEndpoint): void {
  openEndpoint = endpoint;
}

/** The site of the open endpoint with this slug, or null when the dashboard has not said. */
export function openEndpointSite(slug: string): { site: EndpointSite | undefined } | null {
  return openEndpoint?.slug === slug ? { site: openEndpoint.site } : null;
}

/**
 * Public pages both sites have (the home and pricing pages, and the docs):
 * switching from one opens the same page on the other site, signed in or
 * not. Every other public page is one site's own.
 */
export function sharedPublicPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/pricing" ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/")
  );
}

/**
 * One switch at a time per page: a second click would make a new ticket,
 * and GoTrue keeps only the newest sign-in token, so the first would fail.
 */
let switching = false;

/**
 * Moves the browser to the other site (lib/site-switch.ts). Signed in, it
 * asks this site for a grant with the session's own token and follows it, so
 * the other site signs the same account in and takes this site's cookie
 * banner answer along; signed out, or when that fails,
 * it opens the other site's page (sign-in, with the page to come back to).
 */
export async function switchSite(
  target: SiteKey,
  nextPath: string,
  accessToken: string | null | undefined
): Promise<void> {
  if (switching) return;
  const origin = siteOrigin(target);
  const signIn = () => {
    const login = new URL("/login", origin);
    login.searchParams.set("redirect", nextPath);
    window.location.assign(login.toString());
  };
  if (!accessToken) {
    // Signed out: the same public page there, or its sign-in page on the way to an app page.
    if (sharedPublicPath(nextPath)) window.location.assign(`${origin}${nextPath}`);
    else signIn();
    return;
  }
  switching = true;
  try {
    const response = await fetch("/api/site-switch", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ next: nextPath, consent: analyticsConsent() }),
    });
    if (response.ok) {
      const { url } = (await response.json()) as { url?: string };
      if (url && url.startsWith(`${origin}/`)) {
        window.location.assign(url);
        return;
      }
    }
  } catch {
    // Falls through to signing in there.
  }
  switching = false;
  signIn();
}
