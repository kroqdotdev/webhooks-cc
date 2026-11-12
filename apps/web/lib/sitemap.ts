import { getAllDocSlugs, getDocFrontmatter } from "@/lib/docs";
import { CHANGELOG } from "@/lib/changelog";
import { LAYOUT_TEMPLATES } from "@/lib/layout-templates";
import { MAILHOOKS_FEATURES } from "@/lib/mailhooks-features";
import { mailhooksUrl } from "@/lib/mailhooks-seo";
import { LAST_CONTENT_UPDATE, PUBLIC_SITEMAP_PAGES, SITE_URL } from "@/lib/seo";
import {
  getAllShareFrameworkPages,
  getShareFrameworksLastModified,
} from "@/lib/share-framework-pages";
import { listPublishedBlogPosts } from "@/lib/supabase/blog-posts";
import {
  getAllWebhookProviderPages,
  getWebhookProvidersLastModified,
} from "@/lib/webhook-provider-pages";

/**
 * The URLs each site's sitemaps list. Every site serves the same list in three
 * formats Google accepts: XML (/sitemap.xml), plain text (/sitemap.txt) and
 * RSS 2.0 (/sitemap.rss). Google has never downloaded the XML sitemap on our
 * .cc domains, so the other two are there to see whether its fetcher treats
 * them differently.
 */
export interface SitemapEntry {
  url: string;
  lastModified: Date;
  changeFrequency?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

export type SitemapFormat = "xml" | "txt" | "rss";

// lastmod must reflect real content changes: Google stops trusting it on a site
// whose dates are visibly wrong. Provider and framework pages carry their own
// dates, the /webhooks and /share hubs change whenever one of theirs does, and
// /changelog with its newest entry.
export async function webhooksSitemapEntries(): Promise<SitemapEntry[]> {
  const derivedLastModified: Record<string, Date> = {
    "/webhooks": getWebhookProvidersLastModified(),
    "/share": getShareFrameworksLastModified(),
    "/changelog": newestChangelogDate(),
  };
  const pages: SitemapEntry[] = PUBLIC_SITEMAP_PAGES.map((page) => ({
    url: page.path === "/" ? SITE_URL : `${SITE_URL}${page.path}`,
    lastModified: page.lastModified ?? derivedLastModified[page.path] ?? LAST_CONTENT_UPDATE,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));

  const providers: SitemapEntry[] = getAllWebhookProviderPages().map((page) => ({
    url: `${SITE_URL}/webhooks/${page.slug}`,
    lastModified: page.lastModified,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const frameworks: SitemapEntry[] = getAllShareFrameworkPages().map((page) => ({
    url: `${SITE_URL}/share/${page.slug}`,
    lastModified: page.lastModified,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const docSlugs = await getAllDocSlugs();
  const docEntries = await Promise.all(
    docSlugs.map(async (slug): Promise<SitemapEntry | null> => {
      const fm = await getDocFrontmatter(slug);
      // A doc canonicalised to another page is not one Google should index.
      if (fm?.canonical) return null;
      const path = slug ? `/docs/${slug}` : "/docs";
      return {
        url: `${SITE_URL}${path}`,
        lastModified: fm?.lastUpdated
          ? fm.lastUpdated instanceof Date
            ? fm.lastUpdated
            : new Date(`${fm.lastUpdated}T00:00:00.000Z`)
          : LAST_CONTENT_UPDATE,
        changeFrequency: "monthly",
        priority: slug.startsWith("guides/") ? 0.8 : path === "/docs" ? 0.9 : 0.7,
      };
    })
  );
  const docs: SitemapEntry[] = docEntries.filter((entry): entry is SitemapEntry => entry !== null);

  let posts: Awaited<ReturnType<typeof listPublishedBlogPosts>> = [];
  try {
    posts = await listPublishedBlogPosts();
  } catch {
    // Supabase unavailable (e.g. CI build with placeholder URL): omit blog posts
    // until the next revalidation rather than failing the whole sitemap.
  }
  const blogLastmod = posts.reduce<Date>((latest, post) => {
    const d = new Date(post.updatedAt);
    return d > latest ? d : latest;
  }, LAST_CONTENT_UPDATE);
  const blog: SitemapEntry[] = [
    {
      url: `${SITE_URL}/blog`,
      lastModified: blogLastmod,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...posts.map((post) => ({
      url: `${SITE_URL}/blog/${post.slug}`,
      lastModified: new Date(post.updatedAt),
      changeFrequency: post.changeFrequency,
      priority: post.priority,
    })),
  ];

  return [...pages, ...providers, ...frameworks, ...docs, ...blog];
}

/** When the sender pages last changed. */
const MAILHOOKS_SENDERS_UPDATED = "2026-10-29";
/** The home and pricing pages: Business's domains, file drops and AI assists. */
const MAILHOOKS_PLANS_UPDATED = "2026-11-03";

export function mailhooksSitemapEntries(): SitemapEntry[] {
  const pages = [
    { path: "/", updated: MAILHOOKS_PLANS_UPDATED },
    { path: "/pricing", updated: MAILHOOKS_PLANS_UPDATED },
    { path: "/guides", updated: "2026-11-09" },
    ...MAILHOOKS_FEATURES.map((feature) => ({ path: feature.path, updated: feature.updated })),
    { path: "/parse", updated: MAILHOOKS_SENDERS_UPDATED },
    ...LAYOUT_TEMPLATES.map((t) => ({
      path: `/parse/${t.id}`,
      updated: MAILHOOKS_SENDERS_UPDATED,
    })),
  ];
  return pages.map(({ path, updated }) => ({
    url: mailhooksUrl(path),
    lastModified: new Date(`${updated}T00:00:00.000Z`),
  }));
}

/** The response for one sitemap format, with Last-Modified from the newest entry. */
export function sitemapResponse(
  entries: readonly SitemapEntry[],
  format: SitemapFormat,
  channel: { title: string; link: string }
): Response {
  const latest = entries.reduce<Date>(
    (newest, entry) => (entry.lastModified > newest ? entry.lastModified : newest),
    LAST_CONTENT_UPDATE
  );
  const body =
    format === "txt"
      ? renderSitemapText(entries)
      : format === "rss"
        ? renderSitemapRss(entries, channel, latest)
        : renderSitemapXml(entries);
  const contentType =
    format === "txt"
      ? "text/plain; charset=utf-8"
      : format === "rss"
        ? "application/rss+xml; charset=utf-8"
        : "application/xml; charset=utf-8";
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Last-Modified": latest.toUTCString(),
    },
  });
}

export function renderSitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries
    .map((entry) =>
      [
        "<url>",
        `<loc>${escapeXml(entry.url)}</loc>`,
        `<lastmod>${entry.lastModified.toISOString()}</lastmod>`,
        entry.changeFrequency ? `<changefreq>${entry.changeFrequency}</changefreq>` : null,
        entry.priority !== undefined ? `<priority>${entry.priority}</priority>` : null,
        "</url>",
      ]
        .filter((line) => line !== null)
        .join("\n")
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** Google's text sitemap: one absolute URL per line and nothing else. */
export function renderSitemapText(entries: readonly SitemapEntry[]): string {
  return `${entries.map((entry) => entry.url).join("\n")}\n`;
}

/**
 * An RSS 2.0 feed of every page. Google reads an RSS sitemap's <link> as the
 * URL and <pubDate> as its last modification.
 */
export function renderSitemapRss(
  entries: readonly SitemapEntry[],
  channel: { title: string; link: string },
  lastBuild: Date
): string {
  const items = entries
    .map(
      (entry) => `<item>
<title>${escapeXml(entry.url)}</title>
<link>${escapeXml(entry.url)}</link>
<guid isPermaLink="true">${escapeXml(entry.url)}</guid>
<pubDate>${entry.lastModified.toUTCString()}</pubDate>
</item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>${escapeXml(channel.title)}</title>
<link>${escapeXml(channel.link)}</link>
<description>Every public page on ${escapeXml(channel.title)}</description>
<lastBuildDate>${lastBuild.toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function newestChangelogDate(): Date {
  return CHANGELOG.reduce((latest, entry) => {
    const date = new Date(`${entry.date}T00:00:00.000Z`);
    return date > latest ? date : latest;
  }, LAST_CONTENT_UPDATE);
}
