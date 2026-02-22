import type { Metadata, MetadataRoute } from "next";

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
}

export const PUBLIC_SITEMAP_PAGES: readonly SitemapPageDefinition[] = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/go", changeFrequency: "weekly", priority: 0.9 },
  { path: "/docs", changeFrequency: "weekly", priority: 0.9 },
  { path: "/docs/endpoints", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/endpoints/test-webhooks", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/requests", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/mock-responses", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/cli", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/cli/commands", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/cli/tunnel", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/sdk", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/sdk/api", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/sdk/testing", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/sdk/testing/stripe-vitest", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/sdk/testing/github-jest", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/sdk/testing/playwright-e2e", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/mcp", changeFrequency: "monthly", priority: 0.7 },
  { path: "/compare", changeFrequency: "monthly", priority: 0.7 },
  { path: "/compare/webhook-site", changeFrequency: "monthly", priority: 0.6 },
  { path: "/compare/ngrok", changeFrequency: "monthly", priority: 0.6 },
  { path: "/compare/beeceptor", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.7 },
  { path: "/blog/test-stripe-webhooks-locally-2026", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/webhook-testing-cicd-typescript", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/ai-agents-debug-webhooks-mcp", changeFrequency: "monthly", priority: 0.6 },
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
