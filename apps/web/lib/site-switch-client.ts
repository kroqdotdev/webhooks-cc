import { siteOrigin, type SiteKey } from "@/lib/site";

/**
 * Moves the browser to the other site (lib/site-switch.ts). Signed in, it
 * asks this site for a grant with the session's own token and follows it, so
 * the other site signs the same account in; signed out, or when that fails,
 * it opens the other site's page (sign-in, with the page to come back to).
 */
export async function switchSite(
  target: SiteKey,
  nextPath: string,
  accessToken: string | null | undefined
): Promise<void> {
  const origin = siteOrigin(target);
  if (!accessToken) {
    window.location.assign(`${origin}/`);
    return;
  }
  try {
    const response = await fetch("/api/site-switch", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ next: nextPath }),
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
  const login = new URL("/login", origin);
  login.searchParams.set("redirect", nextPath);
  window.location.assign(login.toString());
}
