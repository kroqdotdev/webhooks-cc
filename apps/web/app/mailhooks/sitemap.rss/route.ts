import { mailhooksSitemapEntries, sitemapResponse } from "@/lib/sitemap";
import { mailhooksUrl } from "@/lib/mailhooks-seo";

export const dynamic = "force-static";

/** mailhooks.cc's sitemap as RSS 2.0 (next.config.ts serves it at the mail host's /sitemap.rss). */
export function GET(): Response {
  return sitemapResponse(mailhooksSitemapEntries(), "rss", {
    title: "mailhooks.cc",
    link: mailhooksUrl("/"),
  });
}
