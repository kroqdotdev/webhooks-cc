import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database";
import { GET as listBlogPosts, POST as createBlogPostRoute } from "@/app/api/blog/route";
import {
  DELETE as deleteBlogPostRoute,
  GET as getBlogPostRoute,
  PATCH as updateBlogPostRoute,
} from "@/app/api/blog/[slug]/route";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://192.168.0.247:8000";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BLOG_API_SECRET = `blog-secret-${Date.now()}`;

if (!SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY env var required for integration tests");
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

describe("Supabase Blog Admin API Integration", () => {
  beforeAll(() => {
    process.env.BLOG_API_SECRET = BLOG_API_SECRET;
  });

  afterAll(async () => {
    await admin.from("blog_posts").delete().like("slug", "api-blog-%");
  });

  it("creates, lists, fetches, updates, and deletes blog posts via the new web API routes", async () => {
    const slug = `api-blog-${Date.now()}`;

    const createResponse = await createBlogPostRoute(
      new Request("https://webhooks.cc/api/blog", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BLOG_API_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slug,
          title: "API Blog Post",
          description: "API Blog Post Description",
          content: "# API Blog Post",
          category: "Guides",
          readMinutes: 5,
          tags: ["api"],
          status: "draft",
          authorName: "webhooks.cc",
          seoTitle: "API Blog Post",
          seoDescription: "SEO description",
          featured: false,
          keywords: ["api"],
          schemaType: "tech-article",
          changeFrequency: "monthly",
          priority: 0.5,
        }),
      })
    );

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { id: string; slug: string };
    expect(created.slug).toBe(slug);
    expect(created.id).toBeTruthy();

    const listResponse = await listBlogPosts(
      new Request("https://webhooks.cc/api/blog", {
        headers: {
          Authorization: `Bearer ${BLOG_API_SECRET}`,
        },
      })
    );

    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as Array<{ slug: string; status: string }>;
    expect(listed.some((post) => post.slug === slug && post.status === "draft")).toBe(true);

    const unauthorizedDraftResponse = await getBlogPostRoute(
      new Request(`https://webhooks.cc/api/blog/${slug}`),
      { params: Promise.resolve({ slug }) }
    );
    expect(unauthorizedDraftResponse.status).toBe(401);

    const getResponse = await getBlogPostRoute(
      new Request(`https://webhooks.cc/api/blog/${slug}`, {
        headers: {
          Authorization: `Bearer ${BLOG_API_SECRET}`,
        },
      }),
      { params: Promise.resolve({ slug }) }
    );

    expect(getResponse.status).toBe(200);
    const fetched = (await getResponse.json()) as { slug: string; title: string; status: string };
    expect(fetched.slug).toBe(slug);
    expect(fetched.status).toBe("draft");

    const updateResponse = await updateBlogPostRoute(
      new Request(`https://webhooks.cc/api/blog/${slug}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${BLOG_API_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "published",
          title: "Published API Blog Post",
        }),
      }),
      { params: Promise.resolve({ slug }) }
    );

    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toEqual({
      slug,
      updated: true,
    });

    const publicGetResponse = await getBlogPostRoute(
      new Request(`https://webhooks.cc/api/blog/${slug}`),
      { params: Promise.resolve({ slug }) }
    );

    expect(publicGetResponse.status).toBe(200);
    const published = (await publicGetResponse.json()) as { title: string; status: string };
    expect(published.title).toBe("Published API Blog Post");
    expect(published.status).toBe("published");

    const deleteResponse = await deleteBlogPostRoute(
      new Request(`https://webhooks.cc/api/blog/${slug}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${BLOG_API_SECRET}`,
        },
      }),
      { params: Promise.resolve({ slug }) }
    );

    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      slug,
      deleted: true,
    });
  });

  it("returns 400s for invalid create and update payloads instead of bubbling database errors", async () => {
    const slug = `api-blog-invalid-${Date.now()}`;

    const invalidCreateResponse = await createBlogPostRoute(
      new Request("https://webhooks.cc/api/blog", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BLOG_API_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slug,
          title: "Invalid Blog Post",
          description: "Missing required fields and wrong types",
          content: "# Invalid",
          category: "Guides",
          readMinutes: "5",
          tags: ["api"],
          status: "draft",
          authorName: "webhooks.cc",
          seoTitle: "Invalid",
          seoDescription: "Invalid",
          featured: false,
          keywords: ["api"],
          schemaType: "tech-article",
          changeFrequency: "monthly",
          priority: 0.5,
        }),
      })
    );

    expect(invalidCreateResponse.status).toBe(400);
    await expect(invalidCreateResponse.json()).resolves.toEqual({
      error: "invalid_body",
    });

    const createResponse = await createBlogPostRoute(
      new Request("https://webhooks.cc/api/blog", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BLOG_API_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slug,
          title: "Valid Blog Post",
          description: "Valid Blog Post Description",
          content: "# Valid Blog Post",
          category: "Guides",
          readMinutes: 5,
          tags: ["api"],
          status: "draft",
          authorName: "webhooks.cc",
          seoTitle: "Valid Blog Post",
          seoDescription: "SEO description",
          featured: false,
          keywords: ["api"],
          schemaType: "tech-article",
          changeFrequency: "monthly",
          priority: 0.5,
        }),
      })
    );

    expect(createResponse.status).toBe(201);

    const invalidUpdateResponse = await updateBlogPostRoute(
      new Request(`https://webhooks.cc/api/blog/${slug}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${BLOG_API_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "scheduled",
        }),
      }),
      { params: Promise.resolve({ slug }) }
    );

    expect(invalidUpdateResponse.status).toBe(400);
    await expect(invalidUpdateResponse.json()).resolves.toEqual({
      error: "invalid_body",
    });
  });
});
