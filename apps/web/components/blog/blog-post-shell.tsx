import Link from "next/link";
import { ArrowLeft, ArrowRight, CalendarDays, Clock3 } from "lucide-react";
import { JsonLd, blogPostingSchema, breadcrumbSchema } from "@/lib/schemas";
import type { TocItem } from "@/components/docs/toc";

export interface BlogPostData {
  slug: string;
  title: string;
  description: string;
  category: string;
  readMinutes: number;
  publishedAt?: number;
  updatedAt: number;
  tags: string[];
  seoTitle: string;
  seoDescription: string;
  keywords: string[];
  schemaType: "howto" | "tech-article" | "faq" | "blog-posting";
  authorName: string;
  canonicalUrl?: string;
  featured: boolean;
}

export interface RelatedPost {
  slug: string;
  title: string;
  description: string;
}

function formatBlogDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

interface BlogPostShellProps {
  post: BlogPostData;
  headings: TocItem[];
  relatedPosts: RelatedPost[];
  isDraft?: boolean;
  children: React.ReactNode;
}

export function BlogPostShell({
  post,
  headings,
  relatedPosts,
  isDraft,
  children,
}: BlogPostShellProps) {
  return (
    <main className="min-h-screen pt-28 pb-20 px-4">
      {!isDraft && <JsonLd data={blogPostingSchema(post)} />}
      {!isDraft && (
        <JsonLd
          data={breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Blog", path: "/blog" },
            { name: post.title, path: `/blog/${post.slug}` },
          ])}
        />
      )}
      <div className="max-w-6xl mx-auto">
        {isDraft && (
          <div className="mb-5 border-2 border-yellow-500 bg-yellow-50 dark:bg-yellow-950 px-4 py-3 text-sm font-bold text-yellow-800 dark:text-yellow-200">
            DRAFT — Not published
          </div>
        )}

        <Link
          href="/blog"
          className="inline-flex items-center gap-2 text-sm font-bold mb-5 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to blog
        </Link>

        <header className="neo-card neo-card-static p-0 overflow-hidden mb-8">
          <div className="h-2 bg-gradient-to-r from-primary via-secondary to-accent" />
          <div className="p-6 md:p-8">
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <span className="text-xs font-bold uppercase tracking-wide border-2 border-foreground px-2 py-1 bg-secondary text-secondary-foreground">
                {post.category}
              </span>
              {post.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs font-bold uppercase tracking-wide border-2 border-foreground px-2 py-1 bg-background"
                >
                  {tag}
                </span>
              ))}
            </div>
            <h1 className="text-3xl md:text-5xl font-bold leading-tight mb-4">{post.title}</h1>
            <p className="text-lg text-muted-foreground max-w-3xl mb-5">{post.description}</p>
            <div className="flex flex-wrap items-center gap-4 text-sm font-medium text-muted-foreground">
              {post.publishedAt && (
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="h-4 w-4" />
                  {formatBlogDate(post.publishedAt)}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="h-4 w-4" />
                {post.readMinutes} min read
              </span>
            </div>
          </div>
        </header>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
          <article className="neo-card neo-card-static p-0 overflow-hidden min-w-0">
            <div className="h-2 bg-gradient-to-r from-secondary via-primary to-secondary" />
            <div className="p-6 md:p-10">
              <div className="docs-content">{children}</div>
            </div>
          </article>

          <aside className="space-y-4 lg:sticky lg:top-28 self-start">
            <div className="neo-card neo-card-static p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
                On this page
              </p>
              <ul className="space-y-2">
                {headings.map((heading) => (
                  <li key={heading.id}>
                    <a
                      href={`#${heading.id}`}
                      className={`text-sm font-medium hover:underline ${heading.level === 3 ? "pl-3" : ""}`}
                    >
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            {relatedPosts.length > 0 && (
              <div className="neo-card neo-card-static p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
                  More guides
                </p>
                <div className="space-y-3">
                  {relatedPosts.map((related) => (
                    <Link key={related.slug} href={`/blog/${related.slug}`} className="block group">
                      <p className="font-bold leading-snug group-hover:underline">
                        {related.title}
                      </p>
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {related.description}
                      </p>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <Link href="/go" className="neo-btn-primary w-full text-center block">
              Try webhooks.cc
              <ArrowRight className="inline-block ml-2 h-4 w-4" />
            </Link>
          </aside>
        </div>
      </div>
    </main>
  );
}
