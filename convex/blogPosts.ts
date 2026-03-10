/**
 * @fileoverview Blog post queries and mutations.
 *
 * Public queries (no auth required):
 * - listPublished: All published posts, sorted by date descending, content stripped
 * - getPublishedBySlug: Single published post by slug
 * - getDraftBySlug: Single draft post by slug (for preview routes)
 *
 * Internal queries/mutations (used by HTTP actions):
 * - getBySlug: Any post by slug (including drafts)
 * - listAll: All posts including drafts, content stripped
 * - create: Insert new post with slug uniqueness validation
 * - update: Partial update by slug
 * - remove: Delete by slug
 */
import { v } from "convex/values";
import { query, internalQuery, internalMutation } from "./_generated/server";

// Shared validator for blog post fields
const blogPostStatusValidator = v.union(v.literal("draft"), v.literal("published"));
const schemaTypeValidator = v.union(
  v.literal("howto"),
  v.literal("tech-article"),
  v.literal("faq"),
  v.literal("blog-posting")
);
const changeFrequencyValidator = v.union(
  v.literal("weekly"),
  v.literal("monthly"),
  v.literal("yearly")
);

// --- Public queries (no auth) ---

/** List all published posts, sorted by date descending, with content stripped. */
export const listPublished = query({
  args: {},
  handler: async (ctx) => {
    const posts = await ctx.db
      .query("blogPosts")
      .withIndex("by_status_publishedAt", (q) => q.eq("status", "published"))
      .order("desc")
      .collect();

    return posts.map(({ content: _content, ...rest }) => rest);
  },
});

/** Get a single published post by slug. Returns null if not found or draft. */
export const getPublishedBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const post = await ctx.db
      .query("blogPosts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!post || post.status !== "published") return null;
    return post;
  },
});

/** Get a single draft post by slug. Returns null if not found or not draft. */
export const getDraftBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const post = await ctx.db
      .query("blogPosts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!post || post.status !== "draft") return null;
    return post;
  },
});

// --- Internal queries ---

/** Get any post by slug (including drafts). Used by HTTP actions. */
export const getBySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    return await ctx.db
      .query("blogPosts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
  },
});

/** List all posts including drafts, with content stripped. */
export const listAll = internalQuery({
  args: {},
  handler: async (ctx) => {
    const posts = await ctx.db
      .query("blogPosts")
      .withIndex("by_status_publishedAt")
      .order("desc")
      .collect();

    return posts.map(({ content: _content, ...rest }) => rest);
  },
});

// --- Internal mutations ---

/** Create a new blog post. Validates slug uniqueness. */
export const create = internalMutation({
  args: {
    slug: v.string(),
    title: v.string(),
    description: v.string(),
    content: v.string(),
    category: v.string(),
    readMinutes: v.number(),
    tags: v.array(v.string()),
    status: blogPostStatusValidator,
    authorName: v.string(),
    seoTitle: v.string(),
    seoDescription: v.string(),
    canonicalUrl: v.optional(v.string()),
    featured: v.boolean(),
    keywords: v.array(v.string()),
    schemaType: schemaTypeValidator,
    changeFrequency: changeFrequencyValidator,
    priority: v.number(),
  },
  handler: async (ctx, args) => {
    // Check slug uniqueness
    const existing = await ctx.db
      .query("blogPosts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (existing) {
      throw new Error("slug_exists");
    }

    const now = Date.now();
    const id = await ctx.db.insert("blogPosts", {
      ...args,
      updatedAt: now,
      publishedAt: args.status === "published" ? now : undefined,
    });

    return { id, slug: args.slug };
  },
});

/** Update a blog post by slug. Accepts partial updates. */
export const update = internalMutation({
  args: {
    slug: v.string(),
    updates: v.object({
      title: v.optional(v.string()),
      description: v.optional(v.string()),
      content: v.optional(v.string()),
      category: v.optional(v.string()),
      readMinutes: v.optional(v.number()),
      tags: v.optional(v.array(v.string())),
      status: v.optional(blogPostStatusValidator),
      authorName: v.optional(v.string()),
      seoTitle: v.optional(v.string()),
      seoDescription: v.optional(v.string()),
      canonicalUrl: v.optional(v.string()),
      featured: v.optional(v.boolean()),
      keywords: v.optional(v.array(v.string())),
      schemaType: v.optional(schemaTypeValidator),
      changeFrequency: v.optional(changeFrequencyValidator),
      priority: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { slug, updates }) => {
    const post = await ctx.db
      .query("blogPosts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!post) {
      throw new Error("not_found");
    }

    // Filter out undefined values from updates
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    // Always update updatedAt
    patch.updatedAt = Date.now();

    // Set publishedAt on first publish (transitioning from draft to published)
    if (updates.status === "published" && !post.publishedAt) {
      patch.publishedAt = Date.now();
    }

    await ctx.db.patch(post._id, patch);

    return { slug, updated: true };
  },
});

/** Delete a blog post by slug. */
export const remove = internalMutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const post = await ctx.db
      .query("blogPosts")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!post) {
      throw new Error("not_found");
    }

    await ctx.db.delete(post._id);
    return { slug, deleted: true };
  },
});
