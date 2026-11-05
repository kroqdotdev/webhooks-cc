import { mailhooksSitemapEntries, sitemapResponse } from "@/lib/sitemap";
import { mailhooksUrl } from "@/lib/mailhooks-seo";

export const dynamic = "force-static";

/** mailhooks.cc's sitemap as plain text (next.config.ts serves it at the mail host's /sitemap.txt). */
export function GET(): Response {
  return sitemapResponse(mailhooksSitemapEntries(), "txt", {
    title: "mailhooks.cc",
    link: mailhooksUrl("/"),
  });
}
