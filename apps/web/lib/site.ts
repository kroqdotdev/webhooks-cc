/**
 * The two sites one app serves: webhooks.cc, and mailhooks.cc, the same
 * accounts, endpoints and billing with a mail-first front door. Which one a
 * request is for comes from its Host: proxy.ts resolves it against the two
 * configured origins (nothing else counts as either) and passes it on in
 * SITE_HEADER, and next.config.ts serves mailhooks.cc's own pages from
 * app/mailhooks by host. Without NEXT_PUBLIC_MAILHOOKS_URL there is one site
 * and nothing changes.
 *
 * Sessions stay per host (Supabase's cookies have no domain), and the OAuth
 * server, agent identities and the MCP server keep the webhooks.cc origin as
 * their issuer on both.
 */

export type SiteKey = "webhooks" | "mailhooks";

/** Request header proxy.ts sets to the request's site; a client's own copy is dropped. */
export const SITE_HEADER = "x-whk-site";

/**
 * Set by proxy.ts on a mailhooks.cc request for a path neither site serves;
 * a next.config.ts rewrite that matches on it serves mailhooks.cc's own 404
 * (app/mailhooks/missing). A header and a config rewrite, not a rewrite made
 * in proxy.ts: that one is absolute, and where the server's own address
 * differs from the one Next gives the proxy it leaves the server and comes
 * back without the mailhooks.cc host, which sent the visitor around in a loop.
 */
export const MAILHOOKS_MISSING_HEADER = "x-whk-missing";

export interface SiteInfo {
  key: SiteKey;
  /** The wordmark and the name in titles. */
  name: string;
  /** One line for metadata and the header's title. */
  tagline: string;
}

export const SITES: Record<SiteKey, SiteInfo> = {
  webhooks: {
    key: "webhooks",
    name: "webhooks.cc",
    tagline: "Webhook testing and inspection",
  },
  mailhooks: {
    key: "mailhooks",
    name: "mailhooks.cc",
    tagline: "Turn the emails you receive into structured data",
  },
};

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The webhooks.cc origin (the app URL). */
export function webhooksOrigin(): string {
  return originOf(process.env.NEXT_PUBLIC_APP_URL) ?? "https://webhooks.cc";
}

/** The mailhooks.cc origin, or null when the app serves one site. */
export function mailhooksOrigin(): string | null {
  return originOf(process.env.NEXT_PUBLIC_MAILHOOKS_URL);
}

export function siteOrigin(site: SiteKey): string {
  return site === "mailhooks" ? (mailhooksOrigin() ?? webhooksOrigin()) : webhooksOrigin();
}

/**
 * The site for a Host header's hostname (any port): mailhooks only for the
 * configured mailhooks host, webhooks for everything else.
 */
export function siteForHost(host: string | null | undefined): SiteKey {
  const mail = mailhooksOrigin();
  if (!mail || !host) return "webhooks";
  const hostname = host.split(":", 1)[0].toLowerCase();
  return hostname === new URL(mail).hostname ? "mailhooks" : "webhooks";
}

/** A value read back from SITE_HEADER: anything unknown is webhooks. */
export function parseSite(value: string | null | undefined): SiteKey {
  return value === "mailhooks" ? "mailhooks" : "webhooks";
}

/** Whether the app serves two sites (NEXT_PUBLIC_MAILHOOKS_URL is set). */
export function twoSites(): boolean {
  return mailhooksOrigin() !== null;
}

/** The site that is not this one. */
export function otherSite(site: SiteKey): SiteKey {
  return site === "mailhooks" ? "webhooks" : "mailhooks";
}

/**
 * Which site's dashboard lists an endpoint (migration 00078). Only the
 * listing: every endpoint keeps both addresses and captures both kinds.
 */
export type EndpointSite = SiteKey | "both";

export const ENDPOINT_SITES: readonly EndpointSite[] = ["webhooks", "mailhooks", "both"];

export function isEndpointSite(value: unknown): value is EndpointSite {
  return value === "webhooks" || value === "mailhooks" || value === "both";
}

/**
 * Whether a site's dashboard lists an endpoint. With one site every endpoint
 * is listed, and an endpoint without a site (an older client's copy) is
 * listed on both.
 */
export function listedOn(endpointSite: EndpointSite | undefined, site: SiteKey): boolean {
  if (!twoSites()) return true;
  return endpointSite === undefined || endpointSite === "both" || endpointSite === site;
}

/** Where an endpoint's dashboard link should go: its own site, or this one when it is on both. */
export function endpointHomeSite(endpointSite: EndpointSite | undefined, site: SiteKey): SiteKey {
  return endpointSite === "webhooks" || endpointSite === "mailhooks" ? endpointSite : site;
}

/** The site's origin for a request, from its Host (for return URLs and links). */
export function requestSiteOrigin(request: Request): string {
  return siteOrigin(siteForHost(request.headers.get("host")));
}

/**
 * mailhooks.cc's own pages, served from app/mailhooks by the host rewrites in
 * next.config.ts (which cannot import this file; its test compares the two).
 * Only /parse has pages below it, one per sender in the layout catalogue.
 */
export const MAILHOOKS_PAGES = [
  "/pricing",
  "/parse",
  "/guides",
  // The feature pages (lib/mailhooks-features.ts; a test compares the two).
  "/google-sheets",
  "/file-drops",
  "/custom-domains",
  "/ai-setup",
  "/integrations",
] as const;

/**
 * Paths mailhooks.cc answers itself: its own pages (served from
 * app/mailhooks), the docs (the same pages as webhooks.cc's, canonical
 * there), signing in, the app, the API and share links. Anything else there
 * is webhooks.cc's (blog, comparisons, legal pages, the CLI and agent flows)
 * and redirects to it.
 */
const MAILHOOKS_PREFIXES = [
  ...MAILHOOKS_PAGES,
  // app/mailhooks/docs, through next.config.ts's host rewrites.
  "/docs",
  "/login",
  "/signup",
  "/auth",
  "/dashboard",
  "/account",
  "/teams",
  "/endpoints",
  "/api",
  "/s",
  "/support",
  // The docs search index, which the support form suggests articles from.
  "/_pagefind",
  "/mailhooks",
  "/email-templates",
  "/_next",
];

/**
 * The first path segments webhooks.cc answers: its routes under app/ (the
 * (settings) group's account and teams included), public/ files and the
 * redirects in next.config.ts. A mailhooks.cc path outside its own list goes
 * to webhooks.cc only when it is one of these; anything else is a mailhooks.cc
 * 404, so a mistyped address stays on the site it was typed for. A unit test
 * keeps the list in step with app/ and public/.
 */
export const WEBHOOKS_TOP_LEVEL = [
  ".well-known",
  "account",
  "agent",
  "android",
  "api",
  "api-explorer",
  "apple-touch-icon.png",
  "auth",
  "auth.md",
  "blog",
  "changelog",
  "cli",
  "compare",
  "dashboard",
  "docs",
  "docs.md",
  "email-templates",
  "email-testing",
  "email-to-webhook",
  "endpoints",
  "favicon.ico",
  "feed.xml",
  "for-teams",
  "go",
  "index.md",
  "install.sh",
  "installation",
  "ios",
  "llms-full.txt",
  "llms.txt",
  "login",
  "mcp",
  "oauth",
  "og-image.jpg",
  "openapi.yaml",
  "ops",
  "pricing",
  "privacy",
  "report",
  "robots.txt",
  "s",
  "signup",
  "sitemap-index.xml",
  "sitemap.rss",
  "sitemap.txt",
  "sitemap.xml",
  "sitemaps",
  "subprocessors",
  "support",
  "teams",
  "terms",
  "video",
  "webhooks",
] as const;

const WEBHOOKS_TOP_LEVEL_SET: ReadonlySet<string> = new Set(WEBHOOKS_TOP_LEVEL);

/** Whether webhooks.cc has something at this path's first segment (see WEBHOOKS_TOP_LEVEL). */
export function existsOnWebhooks(pathname: string): boolean {
  const first = pathname.split("/")[1] ?? "";
  // Root-level verification and icon files in public/ (e.g. a search engine's key file).
  if (/^[^/]+\.(?:txt|svg|png|ico|jpg|jpeg|webp|webmanifest)$/i.test(first)) return true;
  return WEBHOOKS_TOP_LEVEL_SET.has(first);
}

export function servedOnMailhooks(pathname: string): boolean {
  if (pathname === "/") return true;
  // Static files from public/ (icons, images).
  if (/^\/[^/]+\.(?:svg|png|ico|jpg|jpeg|webp|webmanifest)$/i.test(pathname)) return true;
  return MAILHOOKS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
