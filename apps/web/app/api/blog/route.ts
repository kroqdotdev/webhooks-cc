import { createBlogPostSchema } from "@/lib/blog-api-schema";
import { verifyBlogSecret } from "@/lib/blog-api-auth";
import { createBlogPost, listAllBlogPosts, listPublishedBlogPosts } from "@/lib/supabase/blog-posts";

function isSlugExistsError(error: unknown): boolean {
  if (error instanceof Error && error.message === "slug_exists") {
    return true;
  }

  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function POST(request: Request) {
  const authError = verifyBlogSecret(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = createBlogPostSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const result = await createBlogPost(parsed.data);
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (isSlugExistsError(error)) {
      return Response.json({ error: "slug_exists" }, { status: 409 });
    }

    console.error("[blog-api] POST /api/blog failed:", error);
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
    console.error("[blog-api] GET /api/blog failed:", error);
    return Response.json({ error: "Failed to list blog posts" }, { status: 500 });
  }
}
