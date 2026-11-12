import { ogImageNotFound, ogImageResponse } from "@/lib/og/image";
import { TOOL_SLUGS, getTool, toolPath } from "@/lib/tools/catalog";

/**
 * The Open Graph image of every tool page, at /tools/<tool>/opengraph-image.
 *
 * The tool pages are folders of their own (app/tools/discord-webhook-tester),
 * so this folder holds no page: it is one image route for all of them, and
 * createPageMetadata() in lib/seo.ts points each page at its image. A new
 * tool gets one by being listed in lib/tools/catalog.ts.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return TOOL_SLUGS.map((tool) => ({ tool }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  const page = getTool(tool);
  if (!page) return ogImageNotFound();

  return ogImageResponse({
    kind: "Free tools",
    title: page.name,
    subtitle: page.ogSubtitle,
    path: toolPath(page.slug),
  });
}
