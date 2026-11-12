import { ogImageNotFound, ogImageResponse } from "@/lib/og/image";
import { compareImageText } from "@/lib/og/compare";
import { COMPARE_PAGE_SLUGS } from "@/lib/seo";

/**
 * The Open Graph image of every compare page, at /compare/<tool>/opengraph-image.
 *
 * The compare pages are folders of their own (app/compare/ngrok), so this
 * folder holds no page: it is one image route for all of them, and
 * createPageMetadata() in lib/seo.ts points each page at its image. A new
 * compare page gets one by being listed in PUBLIC_SITEMAP_PAGES, and a pair
 * page ("ngrok vs Hookdeck") by its entry in lib/compare-pairs.ts.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return COMPARE_PAGE_SLUGS.map((tool) => ({ tool }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  const text = compareImageText(tool);
  if (!text) return ogImageNotFound();

  return ogImageResponse({ kind: "Compare", ...text, path: `/compare/${tool}` });
}
