import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "webhooks.cc vs Beeceptor",
  description:
    "Compare webhooks.cc and Beeceptor for webhook inspection, replay, local testing, SDK assertions, and developer automation with AI agent workflows.",
  path: "/compare/beeceptor",
});

export default function CompareBeeceptorPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Beeceptor", path: "/compare/beeceptor" },
        ])}
      />
      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Beeceptor</h1>
        <p className="text-lg text-muted-foreground mb-8">
          Beeceptor is strong for API mocking workflows. webhooks.cc is stronger when your main use
          case is webhook debugging and automated verification in local dev and CI pipelines.
        </p>

        <div className="neo-card neo-card-static mb-8">
          <h2 className="text-xl font-bold mb-2">Developer workflow differences</h2>
          <ul className="list-disc list-inside text-muted-foreground space-y-1">
            <li>webhooks.cc includes a native CLI tunnel optimized for webhook flows.</li>
            <li>
              webhooks.cc includes a TypeScript SDK with <code>waitFor</code> test assertions.
            </li>
            <li>webhooks.cc includes first-party MCP tooling for AI coding agents.</li>
            <li>Both can inspect incoming requests and support practical replay workflows.</li>
          </ul>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link href="/go" className="neo-btn-primary">
            Try webhooks.cc
          </Link>
          <Link href="/docs/sdk/testing" className="neo-btn-outline">
            SDK testing docs
          </Link>
        </div>
      </article>
    </main>
  );
}
