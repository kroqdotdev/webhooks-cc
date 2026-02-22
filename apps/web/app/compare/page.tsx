import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "webhooks.cc Comparisons",
  description:
    "Side-by-side comparisons for webhook testing tools, including webhooks.cc vs Webhook.site, ngrok, and Beeceptor with workflow-focused tradeoffs.",
  path: "/compare",
});

const COMPARISONS = [
  {
    href: "/compare/webhook-site",
    title: "webhooks.cc vs Webhook.site",
    summary: "Compare core webhook inspection features, pricing model, and developer workflows.",
  },
  {
    href: "/compare/ngrok",
    title: "webhooks.cc vs ngrok",
    summary:
      "Understand the tradeoffs between a webhook-focused platform and a general tunnel tool.",
  },
  {
    href: "/compare/beeceptor",
    title: "webhooks.cc vs Beeceptor",
    summary: "See how webhook inspection + SDK + MCP compare against API mocking-first workflows.",
  },
] as const;

export default function CompareIndexPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
        ])}
      />
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl md:text-5xl font-bold mb-4">Tool comparisons</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Honest, developer-focused comparisons for common webhook testing alternatives.
        </p>

        <div className="space-y-4">
          {COMPARISONS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="neo-card neo-card-static block transition-colors hover:bg-muted"
            >
              <h2 className="text-xl font-bold mb-2">{item.title}</h2>
              <p className="text-muted-foreground">{item.summary}</p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
