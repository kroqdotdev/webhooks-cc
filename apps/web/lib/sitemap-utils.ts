import { LAST_CONTENT_UPDATE, PUBLIC_SITEMAP_PAGES, SITE_URL } from "./seo";

export interface PublicSitemapEntry {
  path: string;
  url: string;
  lastModified: Date;
  changeFrequency: (typeof PUBLIC_SITEMAP_PAGES)[number]["changeFrequency"];
  priority: number;
}

export function getPublicSitemapEntries(): PublicSitemapEntry[] {
  return PUBLIC_SITEMAP_PAGES.map((page) => ({
    path: page.path,
    url: page.path === "/" ? SITE_URL : `${SITE_URL}${page.path}`,
    lastModified: page.lastModified ?? LAST_CONTENT_UPDATE,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}

export function splitPublicSitemapEntries(entries = getPublicSitemapEntries()) {
  const blog = entries.filter((entry) => entry.path === "/blog" || entry.path.startsWith("/blog/"));
  const docs = entries.filter((entry) => entry.path === "/docs" || entry.path.startsWith("/docs/"));
  const pages = entries.filter(
    (entry) =>
      !(entry.path === "/blog" || entry.path.startsWith("/blog/")) &&
      !(entry.path === "/docs" || entry.path.startsWith("/docs/"))
  );

  return { pages, docs, blog };
}

export function getLatestSitemapUpdate(
  entries: readonly Pick<PublicSitemapEntry, "lastModified">[]
) {
  return entries.reduce<Date>((latest, entry) => {
    if (entry.lastModified > latest) return entry.lastModified;
    return latest;
  }, LAST_CONTENT_UPDATE);
}

export function renderSitemapUrlSetXml(entries: readonly PublicSitemapEntry[]): string {
  const urls = entries
    .map(
      (entry) => `<url>
  <loc>${entry.url}</loc>
  <lastmod>${entry.lastModified.toISOString()}</lastmod>
  <changefreq>${entry.changeFrequency}</changefreq>
  <priority>${entry.priority}</priority>
</url>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}
