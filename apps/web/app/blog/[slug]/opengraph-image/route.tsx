import { ogImageNotFound, ogImageResponse } from "@/lib/og/image";
import { getPublishedBlogPostBySlug } from "@/lib/supabase/blog-posts";

/**
 * A blog post's Open Graph image. Posts live in the database, so nothing is
 * made at build time: an image is rendered the first time it is asked for and
 * kept for an hour, like the post's page. Only a published post has one; a
 * draft or an unknown slug is a 404, so a draft's title is never shown.
 */
export const revalidate = 3600;

export function generateStaticParams() {
  return [];
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // A failed lookup throws, and a thrown error is not cached, unlike a 404.
  const post = await getPublishedBlogPostBySlug(slug, { throwOnError: true });
  if (!post) return ogImageNotFound();

  return ogImageResponse({
    kind: "Blog",
    title: post.title,
    path: `/blog/${post.slug}`,
  });
}
