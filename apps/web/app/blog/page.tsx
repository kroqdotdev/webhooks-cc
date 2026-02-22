import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, CalendarDays, Clock3 } from "lucide-react";
import { createPageMetadata } from "@/lib/seo";
import { BLOG_POSTS, formatBlogDate } from "@/lib/blog";
import { JsonLd, breadcrumbSchema } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "webhooks.cc Blog",
  description:
    "Practical webhook guides for local development, CI assertions, provider signature verification, and AI-assisted debugging workflows.",
  path: "/blog",
});

export default function BlogIndexPage() {
  const featured = BLOG_POSTS[0];
  if (!featured) notFound();
  const posts = BLOG_POSTS.slice(1);

  return (
    <main className="min-h-screen pt-28 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
        ])}
      />
      <div className="max-w-6xl mx-auto">
        <section className="neo-card neo-card-static p-0 overflow-hidden mb-10">
          <div className="h-2 bg-gradient-to-r from-secondary via-primary to-accent" />
          <div className="p-6 md:p-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Engineering Blog
              </p>
              <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-5 leading-tight">
                Webhook guides you can run in one sitting
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl">
                Focused posts for debugging, testing, and automation. Every guide is built around
                real request payloads and repeatable workflows.
              </p>
            </div>

            <div className="neo-card neo-card-static p-5 bg-muted/50">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-4">
                What you get
              </p>
              <ul className="space-y-3 text-sm">
                <li className="font-medium">Practical setup steps, not theory</li>
                <li className="font-medium">Provider-specific payload and signature patterns</li>
                <li className="font-medium">CLI, SDK, and MCP examples you can copy</li>
              </ul>
              <div className="mt-6 pt-4 border-t-2 border-foreground/20">
                <p className="text-xs text-muted-foreground mb-2">Need docs first?</p>
                <Link
                  href="/docs"
                  className="font-bold hover:underline inline-flex items-center gap-2"
                >
                  Open documentation
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section className="mb-8">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
            Featured
          </p>
          <Link href={featured.href} className="neo-card block p-0 overflow-hidden group">
            <div className="h-2 bg-primary" />
            <div className="p-6 md:p-8">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <span className="text-xs font-bold uppercase tracking-wide border-2 border-foreground px-2 py-1 bg-secondary text-secondary-foreground">
                  {featured.category}
                </span>
                <span className="text-sm text-muted-foreground inline-flex items-center gap-1.5">
                  <CalendarDays className="h-4 w-4" />
                  {formatBlogDate(featured.publishedAt)}
                </span>
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

        <section>
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
            Latest posts
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {posts.map((post, index) => (
              <Link
                key={post.slug}
                href={post.href}
                className="neo-card neo-card-static block p-0 overflow-hidden group"
              >
                <div className={index % 2 === 0 ? "h-2 bg-secondary" : "h-2 bg-accent"} />
                <div className="p-5">
                  <div className="flex flex-wrap items-center gap-3 mb-3">
                    <span className="text-xs font-bold uppercase tracking-wide border-2 border-foreground px-2 py-1 bg-background">
                      {post.category}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatBlogDate(post.publishedAt)}
                    </span>
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
      </div>
    </main>
  );
}
