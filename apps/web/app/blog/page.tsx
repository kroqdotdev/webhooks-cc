import Link from "next/link";
import { ArrowRight, CalendarDays, Clock3 } from "lucide-react";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema } from "@/lib/schemas";
import { listPublishedBlogPosts } from "@/lib/supabase/blog-posts";

export const revalidate = 3600;

export const metadata = createPageMetadata({
  title: "Webhook Engineering Blog",
  description:
    "Practical webhook guides for local development, CI assertions, provider signature verification, and AI-assisted debugging workflows.",
  path: "/blog",
});

function formatBlogDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export default async function BlogIndexPage() {
  const posts = await listPublishedBlogPosts();

  if (posts.length === 0) {
    return (
      <main className="min-h-screen pt-28 pb-20 px-4">
        <JsonLd
          data={breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Blog", path: "/blog" },
          ])}
        />
        <div className="max-w-6xl mx-auto text-center">
          <h1 className="text-4xl font-bold mb-4">Blog</h1>
          <p className="text-muted-foreground">No posts yet. Check back soon.</p>
        </div>
      </main>
    );
  }

  const featured = posts.find((p) => p.featured) ?? posts[0]!;
  const rest = posts.filter((p) => p.slug !== featured.slug);
  const latestTwo = rest.slice(0, 2);
  const remaining = rest.slice(2);

  return (
    <main className="min-h-screen pt-28 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
        ])}
      />
      <div className="max-w-6xl mx-auto">
        {/* Compact header */}
        <section className="mb-10">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">Engineering Blog</h1>
          <p className="text-lg text-muted-foreground max-w-2xl">
            Practical webhook guides for local development, CI assertions, provider signatures, and
            AI-assisted debugging workflows.
          </p>
        </section>

        {/* Featured post */}
        <section className="mb-8">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
            Featured
          </p>
          <Link
            href={`/blog/${featured.slug}`}
            className="neo-card block p-0 overflow-hidden group"
          >
            <div className="h-2 bg-primary" />
            <div className="p-6 md:p-8">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <span className="text-xs font-bold uppercase tracking-wide border-2 border-foreground px-2 py-1 bg-secondary text-secondary-foreground">
                  {featured.category}
                </span>
                {featured.publishedAt && (
                  <span className="text-sm text-muted-foreground inline-flex items-center gap-1.5">
                    <CalendarDays className="h-4 w-4" />
                    {formatBlogDate(featured.publishedAt)}
                  </span>
                )}
                <span className="text-sm text-muted-foreground inline-flex items-center gap-1.5">
                  <Clock3 className="h-4 w-4" />
                  {featured.readMinutes} min read
                </span>
              </div>
              <h2 className="text-3xl font-bold mb-3 leading-tight group-hover:underline">
                {featured.title}
              </h2>
              <p className="text-muted-foreground text-lg mb-4">{featured.description}</p>
              <span className="inline-flex items-center gap-2 font-bold">
                Read guide
                <ArrowRight className="h-4 w-4" />
              </span>
            </div>
          </Link>
        </section>

        {/* Latest two posts */}
        {latestTwo.length > 0 && (
          <section className="mb-10">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
              Latest
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {latestTwo.map((post, index) => (
                <Link
                  key={post.slug}
                  href={`/blog/${post.slug}`}
                  className="neo-card block p-0 overflow-hidden group"
                >
                  <div className={index === 0 ? "h-2 bg-secondary" : "h-2 bg-accent"} />
                  <div className="p-5">
                    <div className="flex flex-wrap items-center gap-3 mb-3">
                      <span className="text-xs font-bold uppercase tracking-wide border-2 border-foreground px-2 py-1 bg-background">
                        {post.category}
                      </span>
                      {post.publishedAt && (
                        <span className="text-xs text-muted-foreground">
                          {formatBlogDate(post.publishedAt)}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">{post.readMinutes} min</span>
                    </div>
                    <h3 className="text-xl font-bold mb-2 leading-snug group-hover:underline">
                      {post.title}
                    </h3>
                    <p className="text-muted-foreground">{post.description}</p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* All posts list */}
        {remaining.length > 0 && (
          <section>
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
              All posts
            </p>
            <div className="neo-card neo-card-static p-0 overflow-hidden">
              <div className="h-2 bg-gradient-to-r from-primary via-secondary to-accent" />
              {remaining.map((post, index) => (
                <Link
                  key={post.slug}
                  href={`/blog/${post.slug}`}
                  className={`block px-5 py-4 group transition-colors hover:bg-muted ${
                    index < remaining.length - 1 ? "border-b border-foreground/20" : ""
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-1">
                        <span className="text-xs font-bold uppercase tracking-wide border-2 border-foreground px-2 py-0.5 bg-background shrink-0">
                          {post.category}
                        </span>
                        <h3 className="text-base font-bold leading-snug group-hover:underline truncate">
                          {post.title}
                        </h3>
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-1">
                        {post.description}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0 md:ml-4">
                      {post.publishedAt && <span>{formatBlogDate(post.publishedAt)}</span>}
                      <span>{post.readMinutes} min</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
