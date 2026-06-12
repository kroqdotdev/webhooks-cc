import {
  getPublicSitemapEntries,
  renderSitemapUrlSetXml,
  splitPublicSitemapEntries,
  type PublicSitemapEntry,
} from "@/lib/sitemap-utils";
import { LAST_CONTENT_UPDATE, SITE_URL } from "@/lib/seo";
import { WEBHOOK_PROVIDER_SLUGS } from "@/lib/webhook-provider-pages";

export const revalidate = 3600;

function getProviderSitemapEntries(): PublicSitemapEntry[] {
  return WEBHOOK_PROVIDER_SLUGS.map((slug) => ({
    path: `/webhooks/${slug}`,
    url: `${SITE_URL}/webhooks/${slug}`,
    lastModified: LAST_CONTENT_UPDATE,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));
}

export function GET() {
  const { pages } = splitPublicSitemapEntries(getPublicSitemapEntries());
  return new Response(renderSitemapUrlSetXml([...pages, ...getProviderSitemapEntries()]), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      Vary: "Accept-Encoding",
    },
  });
}
