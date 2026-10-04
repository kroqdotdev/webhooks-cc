import type { MetadataRoute } from "next";
import { getAllDocSlugs, getDocFrontmatter } from "@/lib/docs";
import { CHANGELOG } from "@/lib/changelog";
import { LAST_CONTENT_UPDATE, PUBLIC_SITEMAP_PAGES, SITE_URL } from "@/lib/seo";
import { listPublishedBlogPosts } from "@/lib/supabase/blog-posts";
import {
  getAllWebhookProviderPages,
  getWebhookProvidersLastModified,
} from "@/lib/webhook-provider-pages";

export const revalidate = 3600;

// One flat /sitemap.xml. It replaced a sitemap index with three child
// sitemaps: Google Search Console kept reporting the index as "Couldn't
// fetch" and never requested the children, while the site is small enough
// (well under the 50,000 URL limit) that an index buys nothing.
//
// lastmod must reflect real content changes: Google stops trusting it on a site
// whose dates are visibly wrong. Provider pages carry their own dates, the
// /webhooks hub changes whenever one of them does, and /changelog with its
// newest entry.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const derivedLastModified: Record<string, Date> = {
    "/webhooks": getWebhookProvidersLastModified(),
    "/changelog": newestChangelogDate(),
  };
  const pages: MetadataRoute.Sitemap = PUBLIC_SITEMAP_PAGES.map((page) => ({
    url: page.path === "/" ? SITE_URL : `${SITE_URL}${page.path}`,
    lastModified: page.lastModified ?? derivedLastModified[page.path] ?? LAST_CONTENT_UPDATE,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));

  const providers: MetadataRoute.Sitemap = getAllWebhookProviderPages().map((page) => ({
    url: `${SITE_URL}/webhooks/${page.slug}`,
    lastModified: page.lastModified,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const docSlugs = await getAllDocSlugs();
  const docs: MetadataRoute.Sitemap = await Promise.all(
    docSlugs.map(async (slug) => {
      const fm = await getDocFrontmatter(slug);
      const path = slug ? `/docs/${slug}` : "/docs";
      return {
        url: `${SITE_URL}${path}`,
        lastModified: fm?.lastUpdated
          ? fm.lastUpdated instanceof Date
            ? fm.lastUpdated
            : new Date(`${fm.lastUpdated}T00:00:00.000Z`)
          : LAST_CONTENT_UPDATE,
        changeFrequency: "monthly" as const,
        priority: slug.startsWith("guides/") ? 0.8 : path === "/docs" ? 0.9 : 0.7,
      };
    })
  );

  let posts: Awaited<ReturnType<typeof listPublishedBlogPosts>> = [];
  try {
    posts = await listPublishedBlogPosts();
  } catch {
    // Supabase unavailable (e.g. CI build with placeholder URL): omit blog posts
    // until the next revalidation rather than failing the whole sitemap.
  }
  const blogLastmod = posts.reduce<Date>((latest, post) => {
    const d = new Date(post.updatedAt);
    return d > latest ? d : latest;
  }, LAST_CONTENT_UPDATE);
  const blog: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/blog`,
      lastModified: blogLastmod,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...posts.map((post) => ({
      url: `${SITE_URL}/blog/${post.slug}`,
      lastModified: new Date(post.updatedAt),
      changeFrequency: post.changeFrequency,
      priority: post.priority,
    })),
  ];

  return [...pages, ...providers, ...docs, ...blog];
}

function newestChangelogDate(): Date {
  return CHANGELOG.reduce((latest, entry) => {
    const date = new Date(`${entry.date}T00:00:00.000Z`);
    return date > latest ? date : latest;
  }, LAST_CONTENT_UPDATE);
}
