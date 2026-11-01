import { mailhooksUrl } from "@/lib/mailhooks-seo";

export const dynamic = "force-static";

/** mailhooks.cc's robots.txt (next.config.ts serves it at the mail host's /robots.txt). */
export function GET() {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /dashboard",
    "Disallow: /account",
    "Disallow: /teams",
    "Disallow: /api/",
    "Disallow: /auth/",
    "Disallow: /login",
    "",
    `Sitemap: ${mailhooksUrl("/sitemap.xml")}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
