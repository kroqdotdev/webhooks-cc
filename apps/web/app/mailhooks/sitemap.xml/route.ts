import { mailhooksSitemapEntries, sitemapResponse } from "@/lib/sitemap";
import { mailhooksUrl } from "@/lib/mailhooks-seo";

export const dynamic = "force-static";

/** mailhooks.cc's sitemap as XML (next.config.ts serves it at the mail host's /sitemap.xml). */
export function GET(): Response {
  return sitemapResponse(mailhooksSitemapEntries(), "xml", {
    title: "mailhooks.cc",
    link: mailhooksUrl("/"),
  });
}
