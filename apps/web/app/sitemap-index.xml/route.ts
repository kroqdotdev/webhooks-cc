import { SITE_URL } from "@/lib/seo";
import { getLatestSitemapUpdate, splitPublicSitemapEntries } from "@/lib/sitemap-utils";

export const revalidate = 3600;

export function GET() {
  const { pages, docs, blog } = splitPublicSitemapEntries();
  const sitemaps = [
    { loc: `${SITE_URL}/sitemaps/pages.xml`, lastmod: getLatestSitemapUpdate(pages) },
    { loc: `${SITE_URL}/sitemaps/docs.xml`, lastmod: getLatestSitemapUpdate(docs) },
    { loc: `${SITE_URL}/sitemaps/blog.xml`, lastmod: getLatestSitemapUpdate(blog) },
  ];
  const sitemapEntries = sitemaps
    .map(
      (sitemap) => `  <sitemap>
    <loc>${sitemap.loc}</loc>
    <lastmod>${sitemap.lastmod.toISOString()}</lastmod>
  </sitemap>`
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries}
</sitemapindex>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
