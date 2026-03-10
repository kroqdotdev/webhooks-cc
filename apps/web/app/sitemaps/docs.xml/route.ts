import { getAllDocSlugs, getDocFrontmatter } from "@/lib/docs";
import { LAST_CONTENT_UPDATE, SITE_URL } from "@/lib/seo";
import { renderSitemapUrlSetXml } from "@/lib/sitemap-utils";
import type { PublicSitemapEntry } from "@/lib/sitemap-utils";

export const revalidate = 3600;

export async function GET() {
  const slugs = await getAllDocSlugs();

  const entries: PublicSitemapEntry[] = await Promise.all(
    slugs.map(async (slug) => {
      const fm = await getDocFrontmatter(slug);
      const path = slug ? `/docs/${slug}` : "/docs";
      const isGuide = slug.startsWith("guides/");

      return {
        path,
        url: `${SITE_URL}${path}`,
        lastModified: fm?.lastUpdated
          ? fm.lastUpdated instanceof Date
            ? fm.lastUpdated
            : new Date(`${fm.lastUpdated}T00:00:00.000Z`)
          : LAST_CONTENT_UPDATE,
        changeFrequency: "monthly" as const,
        priority: isGuide ? 0.8 : path === "/docs" ? 0.9 : 0.7,
      };
    })
  );

  return new Response(renderSitemapUrlSetXml(entries), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
