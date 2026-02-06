import { NextResponse } from "next/server";

/**
 * Security headers proxy.
 *
 * Sets Content-Security-Policy and related headers on every response.
 * CSP allows Convex cloud/site domains for API and WebSocket connections.
 *
 * Trade-offs:
 * - script-src 'unsafe-inline': Required by Next.js for inline hydration scripts
 *   and the theme-detection script in layout.tsx. Nonce support would require deep
 *   Next.js configuration changes. Mitigated by strict connect-src/object-src.
 * - style-src 'unsafe-inline': Required by Tailwind CSS for inline styles.
 * - connect-src is restricted to self + Convex + webhook receiver domains. The
 *   web replay dialog (which fetches arbitrary user-provided URLs) will be blocked
 *   for external targets — use the CLI `whk replay` command for cross-origin replay.
 */
function sanitizeCspOrigin(raw: string | undefined, fallback: string): string {
  const value = raw || fallback;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return fallback;
  }
}

export function proxy() {
  const response = NextResponse.next();

  const webhookOrigin = sanitizeCspOrigin(
    process.env.NEXT_PUBLIC_WEBHOOK_URL,
    "https://go.webhooks.cc"
  );

  const convexOrigin = sanitizeCspOrigin(
    process.env.NEXT_PUBLIC_CONVEX_URL,
    "https://api.webhooks.cc"
  );

  // Build WebSocket origin from Convex URL (wss:// version)
  let convexWsOrigin: string;
  try {
    const url = new URL(convexOrigin);
    convexWsOrigin = `wss://${url.host}`;
  } catch {
    convexWsOrigin = "wss://api.webhooks.cc";
  }

  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' https://*.convex.cloud https://*.convex.site wss://*.convex.cloud ${convexOrigin} ${convexWsOrigin} ${webhookOrigin}`,
    "object-src 'none'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, robots.txt, sitemap.xml (well-known files)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)",
  ],
};
