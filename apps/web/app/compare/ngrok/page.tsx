import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "webhooks.cc vs ngrok",
  description:
    "Compare webhook-focused testing workflows in webhooks.cc with general-purpose tunneling in ngrok for local debugging, replay, CI assertions, and team workflows.",
  path: "/compare/ngrok",
});

export default function CompareNgrokPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs ngrok", path: "/compare/ngrok" },
        ])}
      />
      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs ngrok</h1>
        <p className="text-lg text-muted-foreground mb-8">
          ngrok is a general tunnel. webhooks.cc is purpose-built for webhook testing. If you need
          request history, replay, filtering, SDK assertions, and MCP workflows, webhooks.cc gives
          you those out of the box.
        </p>

        <div className="grid md:grid-cols-2 gap-4 mb-8">
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-2">Choose webhooks.cc when</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1">
              <li>You need webhook capture + inspection + replay in one tool.</li>
              <li>
                You want SDK <code>waitFor</code> assertions in CI.
              </li>
              <li>You want MCP-driven webhook testing with coding agents.</li>
              <li>You want search/export/mock response controls from the same endpoint.</li>
            </ul>
          </div>
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-2">Choose ngrok when</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1">
              <li>You need broad generic tunneling use cases beyond webhooks.</li>
              <li>You need networking features not tied to webhook workflows.</li>
              <li>You already standardized on ngrok across your infrastructure.</li>
            </ul>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link href="/go" className="neo-btn-primary">
            Try webhooks.cc
          </Link>
          <Link href="/docs/cli/tunnel" className="neo-btn-outline">
            See tunnel docs
          </Link>
        </div>
      </article>
    </main>
  );
}
