import { getConvexClient } from "@/lib/convex-client";
import { api } from "@convex/_generated/api";
import { SITE_NAME, SITE_URL } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const revalidate = 3600;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const convex = getConvexClient();
  const posts = await convex.query(api.blogPosts.listPublished);

  const lastBuildDate = posts[0]
    ? new Date(posts[0].updatedAt).toUTCString()
    : new Date().toUTCString();

  const items = posts
    .map((post) => {
      const url = `${SITE_URL}/blog/${post.slug}`;
      const pubDate = post.publishedAt
        ? new Date(post.publishedAt).toUTCString()
        : new Date(post.updatedAt).toUTCString();
      return `<item>
  <title>${xmlEscape(post.title)}</title>
  <link>${url}</link>
  <guid>${url}</guid>
  <pubDate>${pubDate}</pubDate>
  <description>${xmlEscape(post.seoDescription || post.description)}</description>
  <category>${xmlEscape(post.category)}</category>
</item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${xmlEscape(`${SITE_NAME} Blog`)}</title>
  <link>${SITE_URL}/blog</link>
  <description>${xmlEscape(
    "Practical webhook guides for local development, CI assertions, and AI-assisted debugging workflows."
  )}</description>
  <language>en-us</language>
  <lastBuildDate>${lastBuildDate}</lastBuildDate>
  <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml" xmlns:atom="http://www.w3.org/2005/Atom" />
${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
