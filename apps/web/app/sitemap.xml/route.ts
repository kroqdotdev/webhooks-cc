import { SITE_URL } from "@/lib/seo";

export function GET() {
  return new Response(null, {
    status: 301,
    headers: { Location: `${SITE_URL}/sitemap-index.xml` },
  });
}
