import { safeEqual } from "@/lib/crypto";
import { reportError } from "@/lib/observability";

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function verifyBlogSecret(request: Request): Response | null {
  const authHeader = request.headers.get("Authorization");
  const expectedSecret = process.env.BLOG_API_SECRET;

  if (!expectedSecret) {
    reportError("[blog-api] BLOG_API_SECRET is not configured");
    return jsonError("internal_error", 500);
  }

  const providedSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!safeEqual(expectedSecret, providedSecret)) {
    return jsonError("unauthorized", 401);
  }

  return null;
}
