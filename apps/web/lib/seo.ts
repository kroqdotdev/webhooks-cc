import type { Metadata, MetadataRoute } from "next";
import type { BlogPostData } from "@/components/blog/blog-post-shell";

export const SITE_URL = "https://webhooks.cc";
export const SITE_NAME = "webhooks.cc";
export const DEFAULT_PAGE_TITLE = "Webhook Testing Platform: CLI, SDK & MCP";
export const DEFAULT_PAGE_DESCRIPTION =
  "Capture and inspect webhooks in real time. Forward to localhost with the CLI, test in CI with the TypeScript SDK, and automate workflows with the MCP server.";
export const DEFAULT_OG_IMAGE_PATH = "/og-image.png";

export const LAST_CONTENT_UPDATE = new Date("2026-02-19T00:00:00.000Z");

export interface SitemapPageDefinition {
  path: string;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
  priority: number;
  lastModified?: Date;
}

export const PUBLIC_SITEMAP_PAGES: readonly SitemapPageDefinition[] = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/go", changeFrequency: "weekly", priority: 0.9 },
  // Docs pages are auto-generated from content/docs/ in sitemaps/docs.xml
  { path: "/compare", changeFrequency: "monthly", priority: 0.7 },
  { path: "/compare/webhook-site", changeFrequency: "monthly", priority: 0.6 },
  { path: "/compare/ngrok", changeFrequency: "monthly", priority: 0.6 },
  { path: "/compare/beeceptor", changeFrequency: "monthly", priority: 0.6 },
  // Blog pages are dynamically generated from Convex in sitemaps/blog.xml
  { path: "/installation", changeFrequency: "monthly", priority: 0.8 },
  { path: "/support", changeFrequency: "monthly", priority: 0.6 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
];

interface PageMetadataInput {
  title: string;
  description: string;
  path: string;
  noIndex?: boolean;
  keywords?: readonly string[];
}

function toAbsoluteUrl(path: string): string {
  if (path === "/") {
    return SITE_URL;
  }

  return `${SITE_URL}${path}`;
}

export function createPageMetadata({
  title,
  description,
  path,
  noIndex = false,
  keywords,
}: PageMetadataInput): Metadata {
  const absoluteUrl = toAbsoluteUrl(path);

  return {
    title,
    description,
    alternates: {
      canonical: path,
    },
    openGraph: {
      type: "website",
      locale: "en_US",
      url: absoluteUrl,
      siteName: SITE_NAME,
      title,
      description,
      images: [DEFAULT_OG_IMAGE_PATH],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [DEFAULT_OG_IMAGE_PATH],
    },
    robots: {
      index: !noIndex,
      follow: !noIndex,
    },
    keywords: keywords ? [...keywords] : undefined,
  };
}

export function createDynamicBlogPostMetadata(post: BlogPostData): Metadata {
  const title = post.seoTitle || post.title;
  const description = post.seoDescription || post.description;
  const canonical = post.canonicalUrl ?? `/blog/${post.slug}`;
  const absoluteUrl = toAbsoluteUrl(`/blog/${post.slug}`);
  const publishedTime = post.publishedAt ? new Date(post.publishedAt).toISOString() : undefined;
  const modifiedTime = new Date(post.updatedAt).toISOString();

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      type: "article",
      locale: "en_US",
      url: absoluteUrl,
      siteName: SITE_NAME,
      title,
      description,
      images: [DEFAULT_OG_IMAGE_PATH],
      publishedTime,
      modifiedTime,
      section: post.category,
      tags: [...post.tags],
      authors: [post.authorName],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [DEFAULT_OG_IMAGE_PATH],
    },
    robots: {
      index: true,
      follow: true,
    },
    keywords: [...new Set([...post.keywords, ...post.tags.map((t) => t.toLowerCase())])],
    authors: [{ name: post.authorName, url: SITE_URL }],
  };
}
