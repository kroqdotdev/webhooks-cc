import { siteForHost, siteOrigin } from "@/lib/site";

/**
 * Redirect helpers shared by the auth route handlers (/auth/callback for
 * OAuth PKCE, /auth/confirm for email token-hash links).
 */

/**
 * Only allow same-origin path redirects. Anything that is not a single-slash
 * path ("//evil" would be protocol-relative, "https://..." and "javascript:"
 * are absolute) falls back.
 */
export function sanitizeNextPath(raw: string | null, fallback = "/dashboard"): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}

/**
 * Base URL to redirect to after a successful auth handoff: the origin of the
 * site the request came to (lib/site.ts), from x-forwarded-host or Host,
 * so a session set on mailhooks.cc lands on mailhooks.cc. Only the two
 * configured origins can come out, never a host a request names. In
 * development the request's own host is trusted as-is.
 */
export function resolveRedirectBase(request: Request, origin: string): string {
  if (process.env.NODE_ENV === "development") {
    // The host the browser used: Next reports a local request's origin as
    // localhost, which is another cookie host than webhooks.localhost.
    const host = request.headers.get("host");
    return host ? `${new URL(origin).protocol}//${host}` : origin;
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return siteOrigin(siteForHost(host));
}

/**
 * GoTrue renders `{{ .RedirectTo }}` (the `emailRedirectTo` passed at sign-up,
 * or SITE_URL when none was given) into the confirmation link as
 * `redirect_to`. Use it only when it points at one of our own origins, and
 * only its path + query, so the email can never redirect off-site; the bare
 * site root (GoTrue's default) and anything foreign fall back.
 */
export function nextFromRedirectTo(
  raw: string | null,
  allowedOrigins: string[],
  fallback = "/dashboard"
): string {
  if (!raw) return fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fallback;
  }
  if (!allowedOrigins.includes(url.origin)) return fallback;
  if (url.pathname === "/" && !url.search) return fallback;
  return sanitizeNextPath(`${url.pathname}${url.search}`, fallback);
}
