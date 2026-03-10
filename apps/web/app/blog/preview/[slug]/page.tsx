import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getConvexClient } from "@/lib/convex-client";
import { api } from "@convex/_generated/api";
import { compileBlogMDX } from "@/lib/blog-mdx";
import { BlogPostShell, type BlogPostData } from "@/components/blog/blog-post-shell";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    robots: { index: false, follow: false },
  };
}

export default async function BlogPreviewPage({ params }: PageProps) {
  const { slug } = await params;
  const convex = getConvexClient();
  const post = await convex.query(api.blogPosts.getDraftBySlug, { slug });

  if (!post) notFound();

  const { content, headings } = await compileBlogMDX(post.content);

  return (
    <BlogPostShell post={post as BlogPostData} headings={headings} relatedPosts={[]} isDraft>
      {content}
    </BlogPostShell>
  );
}
