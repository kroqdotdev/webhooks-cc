import { getAllDocSlugs, getDocFrontmatter } from "@/lib/docs";
import { CHANGELOG } from "@/lib/changelog";
import { LAST_CONTENT_UPDATE, PUBLIC_SITEMAP_PAGES, SITE_URL } from "@/lib/seo";
import { listPublishedBlogPosts } from "@/lib/supabase/blog-posts";
import {
  getAllWebhookProviderPages,
  getWebhookProvidersLastModified,
} from "@/lib/webhook-provider-pages";

export const revalidate = 3600;

interface SitemapEntry {
  url: string;
  lastModified: Date;
  changeFrequency: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority: number;
}

// One flat /sitemap.xml served by an explicit Route Handler so we control the
// exact HTTP response headers (including Last-Modified and Content-Type).
//
// lastmod must reflect real content changes: Google stops trusting it on a site
// whose dates are visibly wrong. Provider pages carry their own dates, the
// /webhooks hub changes whenever one of them does, and /changelog with its
// newest entry.
export async function GET(): Promise<Response> {
  const derivedLastModified: Record<string, Date> = {
    "/webhooks": getWebhookProvidersLastModified(),
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

  const entries = [...pages, ...providers, ...docs, ...blog];
  const latestModified = entries.reduce<Date>(
    (latest, entry) => (entry.lastModified > latest ? entry.lastModified : latest),
    LAST_CONTENT_UPDATE
  );

  const xml = renderSitemapXml(entries);

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Last-Modified": latestModified.toUTCString(),
    },
  });
}

function renderSitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries
    .map(
      (entry) => `<url>
<loc>${escapeXml(entry.url)}</loc>
<lastmod>${entry.lastModified.toISOString()}</lastmod>
<changefreq>${entry.changeFrequency}</changefreq>
<priority>${entry.priority}</priority>
</url>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
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
