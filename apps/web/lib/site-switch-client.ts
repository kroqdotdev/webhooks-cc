import { siteOrigin, type SiteKey } from "@/lib/site";

/**
 * One switch at a time per page: a second click would make a new ticket,
 * and GoTrue keeps only the newest sign-in token, so the first would fail.
 */
let switching = false;

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
  if (switching) return;
  const origin = siteOrigin(target);
  const signIn = () => {
    const login = new URL("/login", origin);
    login.searchParams.set("redirect", nextPath);
    window.location.assign(login.toString());
  };
  if (!accessToken) {
    // Signed out: the other site's home, or its sign-in page on the way to an app page.
    if (nextPath === "/") window.location.assign(`${origin}/`);
    else signIn();
    return;
  }
  switching = true;
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
  switching = false;
  signIn();
}
