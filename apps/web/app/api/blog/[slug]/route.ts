import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { updateBlogPostSchema } from "@/lib/blog-api-schema";
import { verifyBlogSecret } from "@/lib/blog-api-auth";
import {
  deleteBlogPostBySlug,
  getAnyBlogPostBySlug,
  updateBlogPostBySlug,
} from "@/lib/supabase/blog-posts";
import { reportError } from "@/lib/observability";
import { parseJsonBodyWith } from "@/lib/request-validation";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!slug) {
    return Response.json({ error: "missing_slug" }, { status: 400 });
  }

  try {
    const post = await getAnyBlogPostBySlug(slug);
    if (!post) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    if (post.status === "draft") {
      const authError = verifyBlogSecret(request);
      if (authError) return authError;
    }

    return Response.json(post);
  } catch (error) {
    reportError("[blog-api] GET /api/blog/[slug] failed", error);
    return Response.json({ error: "Failed to get blog post" }, { status: 500 });
  }
}

// A post's content is long: well past the default body limit.
const MAX_POST_BYTES = 2 * 1024 * 1024;

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const authError = verifyBlogSecret(request);
  if (authError) return authError;

  const { slug } = await params;
  if (!slug) {
    return Response.json({ error: "missing_slug" }, { status: 400 });
  }

  const parsed = await parseJsonBodyWith(request, updateBlogPostSchema, {
    message: "invalid_body",
    invalidJson: "invalid_json",
    maxSize: MAX_POST_BYTES,
  });
  if ("error" in parsed) return parsed.error;

  try {
    const result = await updateBlogPostBySlug(slug, parsed.data);
    after(() => {
      revalidatePath("/blog", "page");
      revalidatePath(`/blog/${slug}`, "page");
      // The share image may hold a 404 cached from before the post was live.
      revalidatePath(`/blog/${slug}/opengraph-image`);
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    reportError("[blog-api] PATCH /api/blog/[slug] failed", error);
    return Response.json({ error: "Failed to update blog post" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const authError = verifyBlogSecret(request);
  if (authError) return authError;

  const { slug } = await params;
  if (!slug) {
    return Response.json({ error: "missing_slug" }, { status: 400 });
  }

  try {
    const result = await deleteBlogPostBySlug(slug);
    after(() => {
      revalidatePath("/blog", "page");
      revalidatePath(`/blog/${slug}`, "page");
      // The share image may hold a 404 cached from before the post was live.
      revalidatePath(`/blog/${slug}/opengraph-image`);
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    reportError("[blog-api] DELETE /api/blog/[slug] failed", error);
    return Response.json({ error: "Failed to delete blog post" }, { status: 500 });
  }
}
