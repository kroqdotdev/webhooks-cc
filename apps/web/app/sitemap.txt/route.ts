import { SITE_NAME, SITE_URL } from "@/lib/seo";
import { sitemapResponse, webhooksSitemapEntries } from "@/lib/sitemap";

export const revalidate = 3600;

/** webhooks.cc's sitemap as plain text (lib/sitemap.ts serves the same URLs in every format). */
export async function GET(): Promise<Response> {
  return sitemapResponse(await webhooksSitemapEntries(), "txt", {
    title: SITE_NAME,
    link: SITE_URL,
  });
}
