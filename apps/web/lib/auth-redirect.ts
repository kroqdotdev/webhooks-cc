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
 * Base URL to redirect to after a successful auth handoff. Behind the
 * production proxy the request origin is the internal host, so prefer
 * x-forwarded-host; in development trust the request origin as-is.
 */
export function resolveRedirectBase(request: Request, origin: string): string {
  if (process.env.NODE_ENV === "development") return origin;
  const forwardedHost = request.headers.get("x-forwarded-host");
  return forwardedHost ? `https://${forwardedHost}` : origin;
}
