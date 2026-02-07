import type { Metadata, MetadataRoute } from "next";

export const SITE_URL = "https://webhooks.cc";
export const SITE_NAME = "webhooks.cc";
export const DEFAULT_PAGE_TITLE = "webhooks.cc | Inspect webhooks instantly";
export const DEFAULT_PAGE_DESCRIPTION =
  "The fastest way to debug webhooks. Get a URL in one click, inspect requests in real-time, and forward to localhost.";
export const DEFAULT_OG_IMAGE_PATH = "/og-image.png";

export const LAST_CONTENT_UPDATE = new Date("2026-02-06T00:00:00.000Z");

export interface SitemapPageDefinition {
  path: string;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
  priority: number;
}

export const PUBLIC_SITEMAP_PAGES: readonly SitemapPageDefinition[] = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/go", changeFrequency: "weekly", priority: 0.9 },
  { path: "/docs", changeFrequency: "weekly", priority: 0.9 },
  { path: "/docs/endpoints", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/requests", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/mock-responses", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/cli", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/cli/commands", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/cli/tunnel", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/sdk", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/sdk/api", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/sdk/testing", changeFrequency: "monthly", priority: 0.7 },
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
  };
}
