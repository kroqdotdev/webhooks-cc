import { publicEnv } from "@/lib/env";
import { getAllDocSlugs, getDocBySlug } from "@/lib/docs";
import { buildDocMarkdown } from "@/lib/docs-markdown";
import { MARKDOWN_RESPONSE_HEADERS } from "@/lib/markdown-negotiation";

// One markdown twin per docs page, prerendered with the HTML pages from the
// same MDX; any other path is a 404 without running this handler.
export const dynamic = "force-static";
export const dynamicParams = false;

export async function generateStaticParams() {
  const slugs = await getAllDocSlugs();
  return slugs.map((slug) => ({ slug: slug ? slug.split("/") : [] }));
}

/**
 * A docs page as markdown, for agents: at /docs.md for the docs root and at
 * /docs/<slug>.md, or at the page's own URL for an Accept header that
 * prefers text/markdown (proxy.ts rewrites both here).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const doc = await getDocBySlug(slug?.join("/") ?? "");
  if (!doc) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(buildDocMarkdown(doc, publicEnv().NEXT_PUBLIC_APP_URL), {
    headers: MARKDOWN_RESPONSE_HEADERS,
  });
}
