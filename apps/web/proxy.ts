import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { NAV_SECTIONS } from "@/lib/docs-nav";
import { layoutTemplate } from "@/lib/layout-templates";
import { imgSrcDirective } from "@/lib/csp-img-src";
import {
  MARKDOWN_TWIN_HEADER,
  isMarkdownTwinPath,
  negotiatesMarkdown,
} from "@/lib/markdown-negotiation";
import {
  MAILHOOKS_MISSING_HEADER,
  MAILHOOKS_PAGES,
  SITE_HEADER,
  existsOnWebhooks,
  mailhooksOrigin,
  servedOnMailhooks,
  siteForHost,
  webhooksOrigin,
} from "@/lib/site";

/**
 * Proxy: markdown twins, Supabase session refresh, security headers.
 *
 * 1. Refuses Server Action probes and POST requests outside /api.
 * 2. Marks requests that prefer a page's markdown twin (next.config.ts rewrites them).
 * 3. Otherwise refreshes the Supabase JWT so server components get fresh cookies.
 * 4. Sets Content-Security-Policy and related headers on every response.
 *
 * Before all of that it settles the site (lib/site.ts): mailhooks.cc answers
 * only its own paths and sends the rest to webhooks.cc, and the pages behind
 * its host rewrites (app/mailhooks) are not served on webhooks.cc.
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
  // /support itself is a public page; a ticket or the form is not.
  if (pathname.startsWith("/support/")) return true;
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
    // Staff only. Never listed in robots.txt or the sitemap, which would advertise it.
    "/ops",
    // The form for reporting a shared preview: reached from previews, not searches.
    "/report",
  ];
  return privatePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

const MAILHOOKS_PAGE_SET: ReadonlySet<string> = new Set(MAILHOOKS_PAGES);

/** Every doc's path, from the docs nav (lib/docs-nav.test.ts keeps it equal to content/docs). */
const DOC_PATHS: ReadonlySet<string> = new Set(
  NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.href)).filter(
    (href) => href === "/docs" || href.startsWith("/docs/")
  )
);

/**
 * A path under /docs that is no doc. mailhooks.cc's docs are prerendered
 * under app/mailhooks, and Next answers a slug it did not prerender with the
 * root 404 (webhooks.cc's), so the proxy marks these for mailhooks.cc's own.
 * Markdown twins (/docs/<slug>.md) are left to their own route.
 */
function unknownDoc(pathname: string): boolean {
  if (!pathname.startsWith("/docs/") || isMarkdownTwinPath(pathname)) return false;
  return !DOC_PATHS.has(pathname.replace(/\/+$/, ""));
}

/**
 * A path below one of mailhooks.cc's own pages that is no page: /parse/<sender>
 * for a sender the catalogue does not have, or anything below the pages that
 * have nothing below them. Those get mailhooks.cc's 404 from the missing
 * rewrite (uncacheable) instead of being rendered or answered by the root 404.
 */
function unknownMailhooksPage(pathname: string): boolean {
  const [, first, ...rest] = pathname.split("/");
  if (rest.length === 0 || !MAILHOOKS_PAGE_SET.has(`/${first}`)) return false;
  if (first !== "parse") return true;
  if (rest.length > 1) return true;
  let sender = rest[0];
  try {
    sender = decodeURIComponent(sender);
  } catch {
    return true;
  }
  return layoutTemplate(sender) === null;
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
  // set their own cookies: /auth/callback exchanges the OAuth code,
  // /auth/confirm verifies an email token hash and /auth/switch carries a
  // session over from the other site, lib/site-switch.ts).
  if (
    !pathname.startsWith("/_next") &&
    !pathname.startsWith("/auth/callback") &&
    !pathname.startsWith("/auth/confirm") &&
    !pathname.startsWith("/auth/switch")
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

  // --- Site ---
  // Temporary redirects (307) while the paths mailhooks.cc serves may still
  // change: a permanent one would stay cached in browsers.
  // The header is ours to set, like the markdown marker below.
  request.headers.delete(SITE_HEADER);
  request.headers.delete(MAILHOOKS_MISSING_HEADER);
  const site = siteForHost(request.headers.get("host") ?? request.nextUrl.host);
  // A path mailhooks.cc does not serve goes to webhooks.cc only when webhooks.cc
  // has it; anything else is mailhooks.cc's own 404 (app/mailhooks/not-found.tsx).
  let missingOnMailhooks = false;
  if (site === "mailhooks" && !servedOnMailhooks(pathname)) {
    if (existsOnWebhooks(pathname)) {
      return NextResponse.redirect(`${webhooksOrigin()}${pathname}${request.nextUrl.search}`, 307);
    }
    missingOnMailhooks = true;
  }
  // app/mailhooks is where the host rewrites lead, not an address of its own:
  // on mailhooks.cc /mailhooks/pricing is /pricing, so an unknown page under
  // it ends at mailhooks.cc's 404 like any other instead of the root one.
  if (site === "mailhooks" && (pathname === "/mailhooks" || pathname.startsWith("/mailhooks/"))) {
    // One leading slash: "//evil.com" or "/\\evil.com" would resolve to another host.
    const own = pathname.slice("/mailhooks".length).replace(/^[/\\]+/, "/") || "/";
    const origin = new URL(mailhooksOrigin()!).origin;
    const target = new URL(`${own}${request.nextUrl.search}`, origin);
    return NextResponse.redirect(target.origin === origin ? target : new URL("/", origin), 307);
  }
  // Under mailhooks.cc's own pages only the catalogue's senders exist.
  if (site === "mailhooks" && (unknownMailhooksPage(pathname) || unknownDoc(pathname))) {
    missingOnMailhooks = true;
  }
  if (site === "webhooks" && (pathname === "/mailhooks" || pathname.startsWith("/mailhooks/"))) {
    const mail = mailhooksOrigin();
    if (!mail) {
      return new NextResponse("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return NextResponse.redirect(
      `${mail}${pathname.slice("/mailhooks".length) || "/"}${request.nextUrl.search}`,
      307
    );
  }
  request.headers.set(SITE_HEADER, site);

  // --- Markdown for agents ---
  // A page asked for with an Accept header that prefers text/markdown is
  // marked for the next.config.ts rewrite to its markdown twin, and a twin's
  // own URL needs nothing (lib/markdown-negotiation.ts). Twins are public,
  // so neither refreshes the session; nor does the MCP server, which reads
  // only bearer tokens.
  // The marker is ours to set: a client sending it could otherwise get a
  // page's markdown under its HTML URL.
  request.headers.delete(MARKDOWN_TWIN_HEADER);

  let response: NextResponse;
  const isRead = request.method === "GET" || request.method === "HEAD";
  if (missingOnMailhooks) {
    // Marked for the next.config.ts rewrite to mailhooks.cc's own 404.
    const headers = new Headers(request.headers);
    headers.set(MAILHOOKS_MISSING_HEADER, "1");
    response = NextResponse.next({ request: { headers } });
  } else if (isRead && negotiatesMarkdown(pathname, request.headers.get("accept"))) {
    const headers = new Headers(request.headers);
    headers.set(MARKDOWN_TWIN_HEADER, "1");
    response = NextResponse.next({ request: { headers } });
  } else if (isMcpPath || isMarkdownTwinPath(pathname)) {
    response = NextResponse.next({ request: { headers: request.headers } });
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
    // challenges.cloudflare.com: Cloudflare Turnstile on the report form (/report).
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://eu-assets.i.posthog.com https://f.webhooks.cc https://challenges.cloudflare.com`,
    "style-src 'self' 'unsafe-inline'",
    imgSrcDirective(),
    "font-src 'self'",
    `connect-src 'self' ${supabaseOrigin} ${supabaseWsOrigin} ${webhookOrigin} https://eu-assets.i.posthog.com https://f.webhooks.cc https://ingest.statoss.com`,
    "frame-src 'self' https://challenges.cloudflare.com",
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
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.(?:xml|txt|rss)).*)",
  ],
};
