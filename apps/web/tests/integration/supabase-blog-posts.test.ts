import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import {
  getDraftBlogPostBySlug,
  getPublishedBlogPostBySlug,
  listPublishedBlogPosts,
} from "@/lib/supabase/blog-posts";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL env var required");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

if (!ANON_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const publishedSlug = `published-post-${Date.now()}`;
const olderPublishedSlug = `older-published-post-${Date.now()}`;
const draftSlug = `draft-post-${Date.now()}`;

describe("Supabase Blog Posts Integration", () => {
  beforeAll(async () => {
    const now = Date.now();

    const { error } = await admin.from("blog_posts").insert([
      {
        slug: olderPublishedSlug,
        title: "Older Published Post",
        description: "Older post description",
        content: "# Older\n\nOlder content",
        category: "Guides",
        read_minutes: 4,
        tags: ["older"],
        status: "published",
        published_at: new Date(now - 86_400_000).toISOString(),
        updated_at: new Date(now - 86_400_000).toISOString(),
        author_name: "webhooks.cc",
        seo_title: "Older Published Post",
        seo_description: "Older post SEO",
        canonical_url: null,
        featured: false,
        keywords: ["older"],
        schema_type: "tech-article",
        change_frequency: "monthly",
        priority: 0.5,
      },
      {
        slug: publishedSlug,
        title: "Published Post",
        description: "Published post description",
        content: "# Published\n\nPublished content",
        category: "Guides",
        read_minutes: 6,
        tags: ["published"],
        status: "published",
        published_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        author_name: "webhooks.cc",
        seo_title: "Published Post",
        seo_description: "Published post SEO",
        canonical_url: null,
        featured: true,
        keywords: ["published"],
        schema_type: "howto",
        change_frequency: "weekly",
        priority: 0.7,
      },
      {
        slug: draftSlug,
        title: "Draft Post",
        description: "Draft description",
        content: "# Draft\n\nDraft content",
        category: "Drafts",
        read_minutes: 3,
        tags: ["draft"],
        status: "draft",
        published_at: null,
        updated_at: new Date(now).toISOString(),
        author_name: "webhooks.cc",
        seo_title: "Draft Post",
        seo_description: "Draft SEO",
        canonical_url: null,
        featured: false,
        keywords: ["draft"],
        schema_type: "faq",
        change_frequency: "monthly",
        priority: 0.4,
      },
    ]);

    if (error) {
      throw error;
    }
  });

  afterAll(async () => {
    await admin
      .from("blog_posts")
      .delete()
      .in("slug", [publishedSlug, olderPublishedSlug, draftSlug]);
  });

  it("lists published posts via the public Supabase path in publish date order", async () => {
    const posts = await listPublishedBlogPosts();
    const publishedIndex = posts.findIndex((post) => post.slug === publishedSlug);
    const olderIndex = posts.findIndex((post) => post.slug === olderPublishedSlug);

    expect(publishedIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(publishedIndex).toBeLessThan(olderIndex);
    expect(posts.some((post) => post.slug === draftSlug)).toBe(false);
  });

  it("returns a published post by slug and hides drafts from the published query", async () => {
    const published = await getPublishedBlogPostBySlug(publishedSlug);
    expect(published?.title).toBe("Published Post");
    expect(published?.content).toContain("Published content");

    const hiddenDraft = await getPublishedBlogPostBySlug(draftSlug);
    expect(hiddenDraft).toBeNull();
  });

  it("returns drafts only through the admin-backed preview helper and enforces anon RLS", async () => {
    const draft = await getDraftBlogPostBySlug(draftSlug);
    expect(draft?.title).toBe("Draft Post");
    expect(draft?.status).toBe("draft");

    const { data, error } = await anon
      .from("blog_posts")
      .select("slug, status")
      .eq("slug", draftSlug);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
