import { publicEnv } from "@/lib/env";
import { getShareFrameworkPage, SHARE_FRAMEWORK_SLUGS } from "@/lib/share-framework-pages";
import { buildShareMarkdown } from "@/lib/share-markdown";
import { MARKDOWN_RESPONSE_HEADERS } from "@/lib/markdown-negotiation";

// One markdown twin per framework guide, prerendered with the HTML pages from
// the same data; any other path is a 404 without running this handler.
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return SHARE_FRAMEWORK_SLUGS.map((framework) => ({ framework }));
}

/**
 * A /share/<framework> guide as markdown, for agents: at /share/<framework>.md,
 * or at the page's own URL for an Accept header that prefers text/markdown
 * (next.config.ts rewrites both here).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ framework: string }> }
) {
  const { framework } = await params;
  const page = getShareFrameworkPage(framework);
  if (!page) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(buildShareMarkdown(page, publicEnv().NEXT_PUBLIC_APP_URL), {
    headers: MARKDOWN_RESPONSE_HEADERS,
  });
}
