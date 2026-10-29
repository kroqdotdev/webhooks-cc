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

/** The site's origin for a request, from its Host (for return URLs and links). */
export function requestSiteOrigin(request: Request): string {
  return siteOrigin(siteForHost(request.headers.get("host")));
}

/**
 * Paths mailhooks.cc answers itself: its own pages (served from
 * app/mailhooks), signing in, the app, the API and share links. Anything
 * else there is webhooks.cc's (docs, blog, comparisons, legal pages, the CLI
 * and agent flows) and redirects to it.
 */
const MAILHOOKS_PREFIXES = [
  "/pricing",
  "/parse",
  "/login",
  "/auth",
  "/dashboard",
  "/account",
  "/teams",
  "/endpoints",
  "/api",
  "/s",
  "/mailhooks",
  "/email-templates",
  "/_next",
];

export function servedOnMailhooks(pathname: string): boolean {
  if (pathname === "/") return true;
  // Static files from public/ (icons, images).
  if (/^\/[^/]+\.(?:svg|png|ico|jpg|jpeg|webp|webmanifest)$/i.test(pathname)) return true;
  return MAILHOOKS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
