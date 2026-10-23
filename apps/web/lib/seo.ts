import type { Metadata, MetadataRoute } from "next";
import type { BlogPostData } from "@/components/blog/blog-post-shell";

export const SITE_URL = "https://webhooks.cc";
export const SITE_NAME = "webhooks.cc";
export const DEFAULT_PAGE_TITLE = "Webhook Testing Platform: CLI, SDK & MCP";
export const DEFAULT_PAGE_DESCRIPTION =
  "Capture and inspect webhooks in real time. Forward to localhost with the CLI, test in CI with the TypeScript SDK, and automate workflows with the MCP server.";
export const DEFAULT_OG_IMAGE_PATH = "/og-image.jpg";

export const LAST_CONTENT_UPDATE = new Date("2026-07-05T00:00:00.000Z");

// Privacy policy, terms, and the subprocessor list usually change together.
const LEGAL_PAGES_UPDATED = new Date("2026-10-05T00:00:00.000Z");
// The privacy policy alone: share links (retention of shared copies).
const PRIVACY_UPDATED = new Date("2026-10-23T00:00:00.000Z");

// Email capture and forwarding: the two email pages.
const EMAIL_PAGES_UPDATED = new Date("2026-10-08T00:00:00.000Z");

// The Search Console pass: the public Teams page, the landing page that links
// it, and comparison pages with fresh tables and the questions people (and AI
// search) ask about them.
const SEO_PASS_UPDATED = new Date("2026-10-20T00:00:00.000Z");

export interface SitemapPageDefinition {
  path: string;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
  priority: number;
  lastModified?: Date;
}

export const PUBLIC_SITEMAP_PAGES: readonly SitemapPageDefinition[] = [
  { path: "/", changeFrequency: "weekly", priority: 1, lastModified: SEO_PASS_UPDATED },
  // /go permanently redirects to / (the landing page is the guest dashboard now)
  // Individual /webhooks/[provider] pages are appended in app/sitemap.xml/route.ts
  { path: "/webhooks", changeFrequency: "monthly", priority: 0.8 },
  {
    path: "/email-testing",
    changeFrequency: "monthly",
    priority: 0.8,
    lastModified: EMAIL_PAGES_UPDATED,
  },
  {
    path: "/email-to-webhook",
    changeFrequency: "monthly",
    priority: 0.8,
    lastModified: EMAIL_PAGES_UPDATED,
  },
  { path: "/for-teams", changeFrequency: "monthly", priority: 0.8, lastModified: SEO_PASS_UPDATED },
  // Docs pages are auto-generated from content/docs/ in app/sitemap.xml/route.ts
  { path: "/compare", changeFrequency: "monthly", priority: 0.7, lastModified: SEO_PASS_UPDATED },
  {
    path: "/compare/webhook-site",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: SEO_PASS_UPDATED,
  },
  {
    path: "/compare/ngrok",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: SEO_PASS_UPDATED,
  },
  {
    path: "/compare/beeceptor",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: SEO_PASS_UPDATED,
  },
  {
    path: "/compare/requestbin",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: SEO_PASS_UPDATED,
  },
  {
    path: "/compare/hookdeck",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: SEO_PASS_UPDATED,
  },
  {
    path: "/compare/svix",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: SEO_PASS_UPDATED,
  },
  {
    path: "/compare/stripe-cli",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: SEO_PASS_UPDATED,
  },
  { path: "/compare/smee", changeFrequency: "monthly", priority: 0.6 },
  {
    path: "/compare/localtunnel",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: SEO_PASS_UPDATED,
  },
  // Blog pages are dynamically generated from Supabase in app/sitemap.xml/route.ts
  // /api-explorer is noindexed - client-only Scalar viewer, /docs/api owns this query
  { path: "/installation", changeFrequency: "monthly", priority: 0.8 },
  // /login is noindexed - excluded from sitemap intentionally
  { path: "/changelog", changeFrequency: "weekly", priority: 0.5 },
  { path: "/support", changeFrequency: "monthly", priority: 0.6 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3, lastModified: PRIVACY_UPDATED },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3, lastModified: LEGAL_PAGES_UPDATED },
  {
    path: "/subprocessors",
    changeFrequency: "yearly",
    priority: 0.3,
    lastModified: LEGAL_PAGES_UPDATED,
  },
];

interface PageMetadataInput {
  title: string;
  description: string;
  path: string;
  noIndex?: boolean;
  keywords?: readonly string[];
  /** Canonical path when it differs from `path`. */
  canonical?: string;
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
  canonical = path,
}: PageMetadataInput): Metadata {
  const absoluteUrl = toAbsoluteUrl(path);

  return {
    title,
    description,
    alternates: {
      canonical,
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
  const rawTitle = post.seoTitle || post.title;
  const title = rawTitle.replace(/ \| webhooks\.cc$/i, "");
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
