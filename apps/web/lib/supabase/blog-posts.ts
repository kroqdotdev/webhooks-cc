import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "./admin";
import type { Database } from "./database";
import type { BlogPostData } from "@/components/blog/blog-post-shell";

type BlogPostRow = Database["public"]["Tables"]["blog_posts"]["Row"];
type BlogPostStatus = BlogPostRow["status"];
type BlogPostInsert = Database["public"]["Tables"]["blog_posts"]["Insert"];
type BlogPostUpdate = Database["public"]["Tables"]["blog_posts"]["Update"];
type SelectedBlogPostRow = Pick<
  BlogPostRow,
  | "id"
  | "slug"
  | "title"
  | "description"
  | "content"
  | "category"
  | "read_minutes"
  | "tags"
  | "status"
  | "published_at"
  | "updated_at"
  | "author_name"
  | "seo_title"
  | "seo_description"
  | "canonical_url"
  | "featured"
  | "keywords"
  | "schema_type"
  | "change_frequency"
  | "priority"
>;
type BlogPostPreview = Pick<SelectedBlogPostRow, Exclude<keyof SelectedBlogPostRow, "content">>;

export interface BlogPostRecord extends BlogPostData {
  id: string;
  content: string;
  status: BlogPostStatus;
  changeFrequency: "weekly" | "monthly" | "yearly";
  priority: number;
}

export interface BlogPostMutationInput {
  slug: string;
  title: string;
  description: string;
  content: string;
  category: string;
  readMinutes: number;
  tags: string[];
  status: BlogPostStatus;
  authorName: string;
  seoTitle: string;
  seoDescription: string;
  canonicalUrl?: string;
  featured: boolean;
  keywords: string[];
  schemaType: BlogPostRecord["schemaType"];
  changeFrequency: BlogPostRecord["changeFrequency"];
  priority: number;
}

export interface BlogPostUpdateInput {
  title?: string;
  description?: string;
  content?: string;
  category?: string;
  readMinutes?: number;
  tags?: string[];
  status?: BlogPostStatus;
  authorName?: string;
  seoTitle?: string;
  seoDescription?: string;
  canonicalUrl?: string;
  featured?: boolean;
  keywords?: string[];
  schemaType?: BlogPostRecord["schemaType"];
  changeFrequency?: BlogPostRecord["changeFrequency"];
  priority?: number;
}

const BASE_SELECT =
  "id, slug, title, description, category, read_minutes, tags, status, published_at, updated_at, author_name, seo_title, seo_description, canonical_url, featured, keywords, schema_type, change_frequency, priority";
const FULL_SELECT = `${BASE_SELECT}, content`;

let _public: SupabaseClient<Database> | null = null;

function createPublicClient(): SupabaseClient<Database> | null {
  if (_public) {
    return _public;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return null;
  }

  _public = createClient<Database>(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });

  return _public;
}

function parseMillis(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeBlogPost(row: SelectedBlogPostRow): BlogPostRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    content: row.content,
    category: row.category,
    readMinutes: row.read_minutes,
    publishedAt: parseMillis(row.published_at),
    updatedAt: parseMillis(row.updated_at) ?? Date.now(),
    tags: row.tags,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    keywords: row.keywords,
    schemaType: row.schema_type,
    authorName: row.author_name,
    canonicalUrl: row.canonical_url ?? undefined,
    featured: row.featured,
    status: row.status,
    changeFrequency: row.change_frequency,
    priority: row.priority,
  };
}

function normalizeBlogPreview(row: BlogPostPreview): Omit<BlogPostRecord, "content"> {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    category: row.category,
    readMinutes: row.read_minutes,
    publishedAt: parseMillis(row.published_at),
    updatedAt: parseMillis(row.updated_at) ?? Date.now(),
    tags: row.tags,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    keywords: row.keywords,
    schemaType: row.schema_type,
    authorName: row.author_name,
    canonicalUrl: row.canonical_url ?? undefined,
    featured: row.featured,
    status: row.status,
    changeFrequency: row.change_frequency,
    priority: row.priority,
  };
}

export async function listPublishedBlogPosts(): Promise<Array<Omit<BlogPostRecord, "content">>> {
  const client = createPublicClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from("blog_posts")
      .select(BASE_SELECT)
      .eq("status", "published")
      .order("published_at", { ascending: false, nullsFirst: false })
      .returns<BlogPostPreview[]>();

    if (error) throw error;
    return (data ?? []).map(normalizeBlogPreview);
  } catch {
    // Graceful fallback during build/CI when Supabase is unreachable
    return [];
  }
}

export async function getPublishedBlogPostBySlug(slug: string): Promise<BlogPostRecord | null> {
  const client = createPublicClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from("blog_posts")
      .select(FULL_SELECT)
      .eq("slug", slug)
      .eq("status", "published")
      .returns<SelectedBlogPostRow>()
      .maybeSingle();

    if (error) throw error;
    return data ? normalizeBlogPost(data) : null;
  } catch {
    return null;
  }
}

export async function getDraftBlogPostBySlug(slug: string): Promise<BlogPostRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("blog_posts")
    .select(FULL_SELECT)
    .eq("slug", slug)
    .eq("status", "draft")
    .returns<SelectedBlogPostRow>()
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? normalizeBlogPost(data) : null;
}

export async function listAllBlogPosts(): Promise<Array<Omit<BlogPostRecord, "content">>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("blog_posts")
    .select(BASE_SELECT)
    .order("updated_at", { ascending: false })
    .returns<BlogPostPreview[]>();

  if (error) {
    throw error;
  }

  return (data ?? []).map(normalizeBlogPreview);
}

export async function getAnyBlogPostBySlug(slug: string): Promise<BlogPostRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("blog_posts")
    .select(FULL_SELECT)
    .eq("slug", slug)
    .returns<SelectedBlogPostRow>()
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? normalizeBlogPost(data) : null;
}

export async function createBlogPost(
  input: BlogPostMutationInput
): Promise<{ id: string; slug: string }> {
  const admin = createAdminClient();

  const { data: existing, error: existingError } = await admin
    .from("blog_posts")
    .select("id")
    .eq("slug", input.slug)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existing) {
    throw new Error("slug_exists");
  }

  const nowIso = new Date().toISOString();
  const insert: BlogPostInsert = {
    slug: input.slug,
    title: input.title,
    description: input.description,
    content: input.content,
    category: input.category,
    read_minutes: input.readMinutes,
    tags: input.tags,
    status: input.status,
    published_at: input.status === "published" ? nowIso : null,
    updated_at: nowIso,
    author_name: input.authorName,
    seo_title: input.seoTitle,
    seo_description: input.seoDescription,
    canonical_url: input.canonicalUrl ?? null,
    featured: input.featured,
    keywords: input.keywords,
    schema_type: input.schemaType,
    change_frequency: input.changeFrequency,
    priority: input.priority,
  };

  const { data, error } = await admin.from("blog_posts").insert(insert).select("id, slug").single();

  if (error) {
    throw error;
  }

  return {
    id: data.id,
    slug: data.slug,
  };
}

export async function updateBlogPostBySlug(
  slug: string,
  updates: BlogPostUpdateInput
): Promise<{ slug: string; updated: true }> {
  const admin = createAdminClient();

  const { data: existing, error: existingError } = await admin
    .from("blog_posts")
    .select("id, published_at")
    .eq("slug", slug)
    .maybeSingle<{ id: string; published_at: string | null }>();

  if (existingError) {
    throw existingError;
  }

  if (!existing) {
    throw new Error("not_found");
  }

  const patch: BlogPostUpdate = {
    updated_at: new Date().toISOString(),
  };

  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.content !== undefined) patch.content = updates.content;
  if (updates.category !== undefined) patch.category = updates.category;
  if (updates.readMinutes !== undefined) patch.read_minutes = updates.readMinutes;
  if (updates.tags !== undefined) patch.tags = updates.tags;
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.authorName !== undefined) patch.author_name = updates.authorName;
  if (updates.seoTitle !== undefined) patch.seo_title = updates.seoTitle;
  if (updates.seoDescription !== undefined) patch.seo_description = updates.seoDescription;
  if (updates.canonicalUrl !== undefined) patch.canonical_url = updates.canonicalUrl;
  if (updates.featured !== undefined) patch.featured = updates.featured;
  if (updates.keywords !== undefined) patch.keywords = updates.keywords;
  if (updates.schemaType !== undefined) patch.schema_type = updates.schemaType;
  if (updates.changeFrequency !== undefined) patch.change_frequency = updates.changeFrequency;
  if (updates.priority !== undefined) patch.priority = updates.priority;

  if (updates.status === "published" && !existing.published_at) {
    patch.published_at = new Date().toISOString();
  }

  const { error } = await admin.from("blog_posts").update(patch).eq("id", existing.id);

  if (error) {
    throw error;
  }

  return {
    slug,
    updated: true,
  };
}

export async function deleteBlogPostBySlug(slug: string): Promise<{ slug: string; deleted: true }> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("blog_posts")
    .delete()
    .eq("slug", slug)
    .select("slug")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("not_found");
  }

  return {
    slug: data.slug,
    deleted: true,
  };
}
