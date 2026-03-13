import { updateBlogPostSchema } from "@/lib/blog-api-schema";
import { verifyBlogSecret } from "@/lib/blog-api-auth";
import {
  deleteBlogPostBySlug,
  getAnyBlogPostBySlug,
  updateBlogPostBySlug,
} from "@/lib/supabase/blog-posts";

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
    console.error("[blog-api] GET /api/blog/[slug] failed:", error);
    return Response.json({ error: "Failed to get blog post" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const authError = verifyBlogSecret(request);
  if (authError) return authError;

  const { slug } = await params;
  if (!slug) {
    return Response.json({ error: "missing_slug" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = updateBlogPostSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const result = await updateBlogPostBySlug(slug, parsed.data);
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    console.error("[blog-api] PATCH /api/blog/[slug] failed:", error);
    return Response.json({ error: "Failed to update blog post" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const authError = verifyBlogSecret(request);
  if (authError) return authError;

  const { slug } = await params;
  if (!slug) {
    return Response.json({ error: "missing_slug" }, { status: 400 });
  }

  try {
    const result = await deleteBlogPostBySlug(slug);
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    console.error("[blog-api] DELETE /api/blog/[slug] failed:", error);
    return Response.json({ error: "Failed to delete blog post" }, { status: 500 });
  }
}
