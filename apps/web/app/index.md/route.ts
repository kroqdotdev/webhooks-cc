import { publicEnv } from "@/lib/env";
import { buildHomeMarkdown } from "@/lib/home-markdown";
import { MARKDOWN_RESPONSE_HEADERS } from "@/lib/markdown-negotiation";

// Built from NEXT_PUBLIC_APP_URL alone, which is fixed at build time.
export const dynamic = "force-static";

/**
 * The home page as markdown, for agents: at /index.md, and at / for an
 * Accept header that prefers text/markdown (proxy.ts rewrites it here).
 */
export function GET() {
  return new Response(buildHomeMarkdown(publicEnv().NEXT_PUBLIC_APP_URL), {
    headers: MARKDOWN_RESPONSE_HEADERS,
  });
}
