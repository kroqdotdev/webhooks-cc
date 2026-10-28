import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { imgSrcDirective } from "@/lib/csp-img-src";
import {
  MARKDOWN_TWIN_HEADER,
  isMarkdownTwinPath,
  negotiatesMarkdown,
} from "@/lib/markdown-negotiation";

/**
 * Proxy: markdown twins, Supabase session refresh, security headers.
 *
 * 1. Refuses Server Action probes and POST requests outside /api.
 * 2. Marks requests that prefer a page's markdown twin (next.config.ts rewrites them).
 * 3. Otherwise refreshes the Supabase JWT so server components get fresh cookies.
 * 4. Sets Content-Security-Policy and related headers on every response.
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
  if (pathname === "/login" || pathname === "/api-explorer") return true;
  const privatePrefixes = [
    "/dashboard",
    "/account",
    "/endpoints",
    "/api",
    "/auth",
    "/cli/verify",
    "/teams",
    "/agent/claim",
    "/blog/preview",
    // Shared request snapshots: links people pass around, never search results.
    "/s",
    // The OAuth consent page and the remote MCP server.
    "/oauth",
    "/mcp",
  ];
  return privatePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Refreshes the Supabase session so server components get fresh cookies. */
async function refreshSession(request: NextRequest, pathname: string): Promise<NextResponse> {
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

  // Refresh session (skip for static assets and the auth handoff routes, which
  // set their own cookies: /auth/callback exchanges the OAuth code and
  // /auth/confirm verifies an email token hash).
  if (
    !pathname.startsWith("/_next") &&
    !pathname.startsWith("/auth/callback") &&
    !pathname.startsWith("/auth/confirm")
  ) {
    await supabase.auth.getUser();
  }

  return supabaseResponse;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // The web app has no Server Actions, and every POST route lives under /api
  // or is the remote MCP server (app/mcp, bearer tokens only).
  // Refusing Next-Action probes and POSTs to page routes here keeps Next's
  // action handler from running (which throws InvariantError when RSC: 1 is
  // also set) and skips the session refresh round-trip on scanner traffic.
  const isApiPath = pathname === "/api" || pathname.startsWith("/api/");
  const isMcpPath = pathname === "/mcp" || pathname.startsWith("/mcp/");
  if (
    request.headers.has("next-action") ||
    (request.method === "POST" && !isApiPath && !isMcpPath)
  ) {
    return new NextResponse("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // --- Markdown for agents ---
  // A page asked for with an Accept header that prefers text/markdown is
  // marked for the next.config.ts rewrite to its markdown twin, and a twin's
  // own URL needs nothing (lib/markdown-negotiation.ts). Twins are public,
  // so neither refreshes the session; nor does the MCP server, which reads
  // only bearer tokens.
  let response: NextResponse;
  const isRead = request.method === "GET" || request.method === "HEAD";
  if (isRead && negotiatesMarkdown(pathname, request.headers.get("accept"))) {
    const headers = new Headers(request.headers);
    headers.set(MARKDOWN_TWIN_HEADER, "1");
    response = NextResponse.next({ request: { headers } });
  } else if (isMcpPath || isMarkdownTwinPath(pathname)) {
    response = NextResponse.next();
  } else {
    response = await refreshSession(request, pathname);
  }

  // --- Security headers ---
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
    imgSrcDirective(pathname),
    "font-src 'self'",
    `connect-src 'self' ${supabaseOrigin} ${supabaseWsOrigin} ${webhookOrigin} https://eu-assets.i.posthog.com https://f.webhooks.cc https://ingest.statoss.com`,
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
  } else if (isMarkdownTwinPath(pathname)) {
    // The HTML page is the one to index; its links still count.
    response.headers.set("X-Robots-Tag", "noindex");
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)"],
};
