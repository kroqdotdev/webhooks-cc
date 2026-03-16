import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy: Supabase session refresh + security headers.
 *
 * 1. Refreshes the Supabase JWT on every request so server components get fresh cookies.
 * 2. Sets Content-Security-Policy and related headers on every response.
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

function shouldNoIndexPath(pathname: string): boolean {
  if (pathname === "/login") return true;
  const privatePrefixes = ["/dashboard", "/account", "/endpoints", "/api", "/cli/verify"];
  return privatePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function proxy(request: NextRequest) {
  // --- Supabase session refresh ---
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session (skip for static assets and auth callback)
  const pathname = request.nextUrl.pathname;
  if (!pathname.startsWith("/_next") && !pathname.startsWith("/auth/callback")) {
    await supabase.auth.getUser();
  }

  // --- Security headers ---
  const response = supabaseResponse;

  const webhookOrigin = sanitizeCspOrigin(
    process.env.NEXT_PUBLIC_WEBHOOK_URL,
    "https://go.webhooks.cc"
  );

  const supabaseOrigin = sanitizeCspOrigin(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    "https://api1.webhooks.cc"
  );

  // WebSocket origin from Supabase URL for Realtime
  let supabaseWsOrigin: string;
  try {
    const url = new URL(supabaseOrigin);
    supabaseWsOrigin = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  } catch {
    supabaseWsOrigin = "wss://api1.webhooks.cc";
  }

  const isDev = process.env.NODE_ENV === "development";
  const edgeSetsSecurityHeaders = process.env.EDGE_SETS_SECURITY_HEADERS === "true";

  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://eu-assets.i.posthog.com https://f.webhooks.cc",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${supabaseOrigin} ${supabaseWsOrigin} ${webhookOrigin} https://eu-assets.i.posthog.com https://f.webhooks.cc`,
    "object-src 'none'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  if (!isDev) {
    directives.push("upgrade-insecure-requests");
  }

  response.headers.set("Content-Security-Policy", directives.join("; "));

  if (!edgeSetsSecurityHeaders) {
    if (!isDev) {
      response.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload"
      );
    }
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }

  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (shouldNoIndexPath(pathname)) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|sitemap-index\\.xml).*)",
  ],
};
