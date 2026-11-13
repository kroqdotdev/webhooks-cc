import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createBlogPostSchema } from "@/lib/blog-api-schema";
import { verifyBlogSecret } from "@/lib/blog-api-auth";
import {
  createBlogPost,
  listAllBlogPosts,
  listPublishedBlogPosts,
} from "@/lib/supabase/blog-posts";
import { reportError } from "@/lib/observability";
import { parseJsonBodyWith } from "@/lib/request-validation";

// A post's content is long: well past the default body limit.
const MAX_POST_BYTES = 2 * 1024 * 1024;

function isSlugExistsError(error: unknown): boolean {
  if (error instanceof Error && error.message === "slug_exists") {
    return true;
  }

  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function POST(request: Request) {
  const authError = verifyBlogSecret(request);
  if (authError) return authError;

  const parsed = await parseJsonBodyWith(request, createBlogPostSchema, {
    message: "invalid_body",
    invalidJson: "invalid_json",
    maxSize: MAX_POST_BYTES,
  });
  if ("error" in parsed) return parsed.error;

  try {
    const result = await createBlogPost(parsed.data);
    after(() => {
      revalidatePath("/blog", "page");
      // The share image may hold a 404 cached from before the post existed.
      revalidatePath(`/blog/${parsed.data.slug}/opengraph-image`);
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (isSlugExistsError(error)) {
      return Response.json({ error: "slug_exists" }, { status: 409 });
    }

    reportError("[blog-api] POST /api/blog failed", error);
    return Response.json({ error: "Failed to create blog post" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("Authorization");
  const hasAuth = authHeader?.startsWith("Bearer ");

  try {
    if (hasAuth) {
      const authError = verifyBlogSecret(request);
      if (authError) return authError;

      const posts = await listAllBlogPosts();
      return Response.json(posts);
    }

    const posts = await listPublishedBlogPosts();
    return Response.json(posts, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    reportError("[blog-api] GET /api/blog failed", error);
    return Response.json({ error: "Failed to list blog posts" }, { status: 500 });
  }
}
