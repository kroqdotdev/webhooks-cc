import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { compileBlogMDX } from "@/lib/blog-mdx";
import { createDynamicBlogPostMetadata } from "@/lib/seo";
import { BlogPostShell, type BlogPostData } from "@/components/blog/blog-post-shell";
import { extractHowToSteps } from "@/lib/mdx-schema-extract";
import { getPublishedBlogPostBySlug, listPublishedBlogPosts } from "@/lib/supabase/blog-posts";

export const revalidate = 3600;

interface PageProps {
  params: Promise<{ slug: string }>;
}

const getPost = cache(async (slug: string) => {
  return await getPublishedBlogPostBySlug(slug);
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return {};
  return createDynamicBlogPostMetadata(post as BlogPostData);
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  const [{ content, headings }, allPosts] = await Promise.all([
    compileBlogMDX(post.content),
    listPublishedBlogPosts(),
  ]);

  const relatedPosts = allPosts
    .filter((p) => p.slug !== post.slug)
    .slice(0, 2)
    .map((p) => ({ slug: p.slug, title: p.title, description: p.description }));

  const howToSteps = post.schemaType === "howto" ? extractHowToSteps(post.content) : undefined;

  return (
    <BlogPostShell
      post={post as BlogPostData}
      headings={headings}
      relatedPosts={relatedPosts}
      howToSteps={howToSteps}
    >
      {content}
    </BlogPostShell>
  );
}
