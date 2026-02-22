import {
  getPublicSitemapEntries,
  renderSitemapUrlSetXml,
  splitPublicSitemapEntries,
} from "@/lib/sitemap-utils";

export const revalidate = 3600;

export function GET() {
  const { blog } = splitPublicSitemapEntries(getPublicSitemapEntries());
  return new Response(renderSitemapUrlSetXml(blog), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
