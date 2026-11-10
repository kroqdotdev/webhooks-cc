import { serverEnv } from "@/lib/env";

/*
 * Cloudflare Turnstile for the public report form (/report). With no keys
 * configured there is nothing to check (development); production sets both.
 * The browser gets the site key from the page, the server checks the token
 * here, once: a token works one time only.
 */

const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The site key the form renders the widget with, or null when the check is off. */
export function turnstileSiteKey(): string | null {
  const env = serverEnv();
  return env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null;
}

/** Whether a form's token passed. True when the check is off. */
export async function passedTurnstile(
  token: string | null,
  address: string | null,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  const env = serverEnv();
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) return true;
  if (!token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (address && address !== "unknown") body.set("remoteip", address);
  try {
    const answer = await fetcher(VERIFY, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await answer.json()) as { success?: boolean };
    return result.success === true;
  } catch (error) {
    console.error("[turnstile] check failed", error instanceof Error ? error.message : error);
    return false;
  }
}
