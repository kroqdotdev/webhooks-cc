import { BLOG_POSTS } from "@/lib/blog";
import { SITE_NAME, SITE_URL } from "@/lib/seo";

export const revalidate = 3600;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toPubDate(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toUTCString();
}

export function GET() {
  const sortedPosts = [...BLOG_POSTS].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const lastBuildDate = sortedPosts[0]
    ? toPubDate(sortedPosts[0].updatedAt || sortedPosts[0].publishedAt)
    : new Date().toUTCString();

  const items = sortedPosts
    .map((post) => {
      const url = `${SITE_URL}${post.href}`;
      return `<item>
  <title>${xmlEscape(post.title)}</title>
  <link>${url}</link>
  <guid>${url}</guid>
  <pubDate>${toPubDate(post.updatedAt || post.publishedAt)}</pubDate>
  <description>${xmlEscape(post.description)}</description>
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
