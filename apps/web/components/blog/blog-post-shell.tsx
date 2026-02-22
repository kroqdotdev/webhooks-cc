import Link from "next/link";
import { ArrowLeft, ArrowRight, CalendarDays, Clock3 } from "lucide-react";
import { BLOG_POSTS, formatBlogDate, type BlogPostMeta } from "@/lib/blog";
import { JsonLd, blogPostingSchema, breadcrumbSchema } from "@/lib/schemas";

export interface BlogSection {
  id: string;
  label: string;
}

interface BlogPostShellProps {
  post: BlogPostMeta;
  sections: readonly BlogSection[];
  children: React.ReactNode;
}

export function BlogPostShell({ post, sections, children }: BlogPostShellProps) {
  const relatedPosts = BLOG_POSTS.filter((item) => item.slug !== post.slug).slice(0, 2);

  return (
    <main className="min-h-screen pt-28 pb-20 px-4">
      <JsonLd data={blogPostingSchema(post)} />
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
          { name: post.title, path: post.href },
        ])}
      />
      <div className="max-w-6xl mx-auto">
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
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4" />
                {formatBlogDate(post.publishedAt)}
              </span>
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
              <div className="prose prose-neutral dark:prose-invert max-w-none prose-headings:font-bold prose-headings:tracking-tight prose-p:text-base prose-p:leading-7 prose-pre:my-4 prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-0 prose-code:before:content-none prose-code:after:content-none">
                {children}
              </div>
            </div>
          </article>

          <aside className="space-y-4 lg:sticky lg:top-28 self-start">
            <div className="neo-card neo-card-static p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
                On this page
              </p>
              <ul className="space-y-2">
                {sections.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`} className="text-sm font-medium hover:underline">
                      {section.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            <div className="neo-card neo-card-static p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
                More guides
              </p>
              <div className="space-y-3">
                {relatedPosts.map((related) => (
                  <Link key={related.slug} href={related.href} className="block group">
                    <p className="font-bold leading-snug group-hover:underline">{related.title}</p>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {related.description}
                    </p>
                  </Link>
                ))}
              </div>
            </div>

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
