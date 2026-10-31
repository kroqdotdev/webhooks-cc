import { LAYOUT_TEMPLATES } from "@/lib/layout-templates";
import { MAILHOOKS_FEATURES } from "@/lib/mailhooks-features";
import { mailhooksUrl } from "@/lib/mailhooks-seo";

export const dynamic = "force-static";

/** When the sender pages last changed. */
const SENDERS_UPDATED = "2026-10-29";
/** The home and pricing pages: Business's domains, file drops and AI assists. */
const PLANS_UPDATED = "2026-10-31";

/** mailhooks.cc's sitemap (next.config.ts serves it at the mail host's /sitemap.xml). */
export function GET() {
  const pages = [
    { path: "/", updated: PLANS_UPDATED },
    { path: "/pricing", updated: PLANS_UPDATED },
    ...MAILHOOKS_FEATURES.map((feature) => ({ path: feature.path, updated: feature.updated })),
    { path: "/parse", updated: SENDERS_UPDATED },
    ...LAYOUT_TEMPLATES.map((t) => ({ path: `/parse/${t.id}`, updated: SENDERS_UPDATED })),
  ];
  const urls = pages
    .map(
      ({ path, updated }) =>
        `  <url>\n    <loc>${mailhooksUrl(path)}</loc>\n    <lastmod>${updated}</lastmod>\n  </url>`
    )
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
