import { LAYOUT_TEMPLATES } from "@/lib/layout-templates";
import { mailhooksUrl } from "@/lib/mailhooks-seo";

export const dynamic = "force-static";

/** When mailhooks.cc's pages last changed. */
const UPDATED = "2026-10-29";

/** mailhooks.cc's sitemap (next.config.ts serves it at the mail host's /sitemap.xml). */
export function GET() {
  const paths = ["/", "/pricing", "/parse", ...LAYOUT_TEMPLATES.map((t) => `/parse/${t.id}`)];
  const urls = paths
    .map(
      (path) =>
        `  <url>\n    <loc>${mailhooksUrl(path)}</loc>\n    <lastmod>${UPDATED}</lastmod>\n  </url>`
    )
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
