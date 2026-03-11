import { getAllDocSlugs, getDocFrontmatter } from "@/lib/docs";
import { LAST_CONTENT_UPDATE, SITE_URL } from "@/lib/seo";
import { getLatestSitemapUpdate, splitPublicSitemapEntries } from "@/lib/sitemap-utils";
import { getConvexClient } from "@/lib/convex-client";
import { api } from "@convex/_generated/api";

export const revalidate = 3600;

export async function GET() {
  const { pages } = splitPublicSitemapEntries();

  // Compute docs lastmod from actual MDX frontmatter
  const slugs = await getAllDocSlugs();
  let docsLastmod = LAST_CONTENT_UPDATE;
  for (const slug of slugs) {
    const fm = await getDocFrontmatter(slug);
    if (fm?.lastUpdated) {
      const d =
        fm.lastUpdated instanceof Date
          ? fm.lastUpdated
          : new Date(`${fm.lastUpdated}T00:00:00.000Z`);
      if (d > docsLastmod) docsLastmod = d;
    }
  }

  // Compute blog lastmod from actual published posts
  let blogLastmod = LAST_CONTENT_UPDATE;
  try {
    const convex = getConvexClient();
    const posts = await convex.query(api.blogPosts.listPublished);
    blogLastmod = posts.reduce<Date>((latest, post) => {
      const d = new Date(post.updatedAt);
      return d > latest ? d : latest;
    }, LAST_CONTENT_UPDATE);
  } catch {
    // Convex unavailable (e.g. CI build with placeholder URL) — use fallback
  }

  const sitemaps = [
    { loc: `${SITE_URL}/sitemaps/pages.xml`, lastmod: getLatestSitemapUpdate(pages) },
    { loc: `${SITE_URL}/sitemaps/docs.xml`, lastmod: docsLastmod },
    { loc: `${SITE_URL}/sitemaps/blog.xml`, lastmod: blogLastmod },
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
      Vary: "Accept-Encoding",
    },
  });
}
