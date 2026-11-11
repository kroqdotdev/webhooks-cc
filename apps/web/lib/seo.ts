import type { Metadata, MetadataRoute } from "next";
import type { BlogPostData } from "@/components/blog/blog-post-shell";

export const SITE_URL = "https://webhooks.cc";
export const SITE_NAME = "webhooks.cc";
export const DEFAULT_PAGE_TITLE = "Webhook Testing Platform: CLI, SDK & MCP";
export const DEFAULT_PAGE_DESCRIPTION =
  "Capture and inspect webhooks and email in real time. Forward to localhost with the CLI, test in CI with the TypeScript, Python and Go SDKs, and automate workflows with the MCP server.";
export const DEFAULT_OG_IMAGE_PATH = "/og-image.jpg";

export const LAST_CONTENT_UPDATE = new Date("2026-07-05T00:00:00.000Z");

// Privacy policy, terms, and the subprocessor list usually change together.
const LEGAL_PAGES_UPDATED = new Date("2026-11-10T00:00:00.000Z");
// The privacy policy alone: shared previews and live tunnel answers.
const PRIVACY_UPDATED = new Date("2026-11-10T00:00:00.000Z");

// The staleness pass over the marketing pages: Python and Go SDKs, destinations,
// stored attachments, mailhooks.cc links, Devin Desktop in the MCP setup.
const MARKETING_PASS_UPDATED = new Date("2026-11-03T00:00:00.000Z");
// Compare pages and their checklist, rechecked against each tool's own site.
const COMPARE_UPDATED = new Date("2026-11-03T00:00:00.000Z");
// The ngrok page alone: whk share and live tunnels, checked against ngrok's
// pricing and free plan limits pages on 2026-11-10.
const COMPARE_NGROK_UPDATED = new Date("2026-11-10T00:00:00.000Z");
// /compare/smee: what smee.io is and how to use it, with gh webhook forward.
const SMEE_COMPARE_UPDATED = new Date("2026-11-10T00:00:00.000Z");
// The mail comparisons (Mailtrap, Mailosaur, MailSlurp), the compare index's
// email checklist, and the rewrite of /email-testing that links to them.
const EMAIL_TESTING_UPDATED = new Date("2026-11-10T00:00:00.000Z");
// /pricing, its own page since it stopped redirecting to the landing page.
const PRICING_PAGE_UPDATED = new Date("2026-11-10T00:00:00.000Z");

export interface SitemapPageDefinition {
  path: string;
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
  priority: number;
  lastModified?: Date;
}

export const PUBLIC_SITEMAP_PAGES: readonly SitemapPageDefinition[] = [
  { path: "/", changeFrequency: "weekly", priority: 1, lastModified: MARKETING_PASS_UPDATED },
  // /go permanently redirects to / (the landing page is the guest dashboard now)
  // Individual /webhooks/[provider] pages are appended in app/sitemap.xml/route.ts
  { path: "/webhooks", changeFrequency: "monthly", priority: 0.8 },
  {
    path: "/email-testing",
    changeFrequency: "monthly",
    priority: 0.8,
    lastModified: EMAIL_TESTING_UPDATED,
  },
  {
    path: "/email-to-webhook",
    changeFrequency: "monthly",
    priority: 0.8,
    lastModified: MARKETING_PASS_UPDATED,
  },
  {
    path: "/for-teams",
    changeFrequency: "monthly",
    priority: 0.8,
    lastModified: MARKETING_PASS_UPDATED,
  },
  {
    path: "/pricing",
    changeFrequency: "monthly",
    priority: 0.9,
    lastModified: PRICING_PAGE_UPDATED,
  },
  // Docs pages are auto-generated from content/docs/ in app/sitemap.xml/route.ts
  {
    path: "/compare",
    changeFrequency: "monthly",
    priority: 0.7,
    lastModified: EMAIL_TESTING_UPDATED,
  },
  {
    path: "/compare/webhook-site",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: COMPARE_UPDATED,
  },
  {
    path: "/compare/ngrok",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: COMPARE_NGROK_UPDATED,
  },
  {
    path: "/compare/beeceptor",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: COMPARE_UPDATED,
  },
  {
    path: "/compare/requestbin",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: COMPARE_UPDATED,
  },
  {
    path: "/compare/hookdeck",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: COMPARE_UPDATED,
  },
  {
    path: "/compare/svix",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: COMPARE_UPDATED,
  },
  {
    path: "/compare/stripe-cli",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: COMPARE_UPDATED,
  },
  {
    path: "/compare/smee",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: SMEE_COMPARE_UPDATED,
  },
  {
    path: "/compare/localtunnel",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: COMPARE_UPDATED,
  },
  {
    path: "/compare/mailtrap",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: EMAIL_TESTING_UPDATED,
  },
  {
    path: "/compare/mailosaur",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: EMAIL_TESTING_UPDATED,
  },
  {
    path: "/compare/mailslurp",
    changeFrequency: "monthly",
    priority: 0.6,
    lastModified: EMAIL_TESTING_UPDATED,
  },
  // Blog pages are dynamically generated from Supabase in app/sitemap.xml/route.ts
  // /api-explorer is noindexed - client-only Scalar viewer, /docs/api owns this query
  {
    path: "/installation",
    changeFrequency: "monthly",
    priority: 0.8,
    lastModified: MARKETING_PASS_UPDATED,
  },
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

/** The size of every generated Open Graph image (lib/og/image.tsx). */
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

/**
 * The compare pages, by the last part of their path. The sitemap list above
 * is the one place every compare page is already named, so a page added
 * there gets its generated image with no other step.
 */
export const COMPARE_PAGE_SLUGS: readonly string[] = PUBLIC_SITEMAP_PAGES.flatMap((page) => {
  const match = /^\/compare\/([a-z0-9-]+)$/.exec(page.path);
  return match ? [match[1]] : [];
});

/**
 * The path of a page's generated Open Graph image, or null for a page that
 * shares the static one. Each path is answered by an `opengraph-image` route
 * beside the page (app/compare, app/webhooks, app/blog/[slug]).
 */
export function generatedOgImagePath(path: string): string | null {
  if (path === "/compare" || path === "/webhooks") return `${path}/opengraph-image`;
  const [, section, slug, ...rest] = path.split("/");
  if (!slug || rest.length > 0) return null;
  if (section === "compare") {
    return COMPARE_PAGE_SLUGS.includes(slug) ? `${path}/opengraph-image` : null;
  }
  // Provider pages and blog posts only ask for metadata once they exist.
  if (section === "webhooks" || section === "blog") return `${path}/opengraph-image`;
  return null;
}

type SocialImages = NonNullable<NonNullable<Metadata["openGraph"]>["images"]>;

/** `openGraph.images` and `twitter.images` for a page: its own image, or the shared one. */
function socialImages(path: string, title: string): SocialImages {
  const generated = generatedOgImagePath(path);
  if (!generated) return [DEFAULT_OG_IMAGE_PATH];
  return [{ url: generated, ...OG_IMAGE_SIZE, type: "image/png", alt: title }];
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
  const images = socialImages(path, title);

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
      images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images,
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
  const images = socialImages(`/blog/${post.slug}`, title);

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
      images,
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
      images,
    },
    robots: {
      index: true,
      follow: true,
    },
    keywords: [...new Set([...post.keywords, ...post.tags.map((t) => t.toLowerCase())])],
    authors: [{ name: post.authorName, url: SITE_URL }],
  };
}
