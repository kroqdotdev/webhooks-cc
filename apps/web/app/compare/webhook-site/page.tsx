import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "webhooks.cc vs Webhook.site",
  description:
    "A practical comparison of webhooks.cc and Webhook.site for developers testing webhook integrations across inspection, replay, SDK workflows, and pricing.",
  path: "/compare/webhook-site",
});

const ROWS = [
  ["Core webhook inspection", "Yes", "Yes"],
  ["CLI tunnel to localhost", "Yes", "Yes"],
  ["TypeScript SDK with waitFor", "Yes", "No first-party SDK"],
  ["MCP server for AI agents", "Yes", "No first-party server"],
  ["Request replay", "Yes", "Yes"],
  ["Search and filtering", "Yes", "Yes"],
  ["Export (JSON/CSV)", "Yes", "Yes"],
  ["Pricing model", "All features on every tier", "Feature-gated tiers"],
] as const;

export default function CompareWebhookSitePage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Webhook.site", path: "/compare/webhook-site" },
        ])}
      />
      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Webhook.site</h1>
        <p className="text-lg text-muted-foreground mb-8">
          Both tools capture and inspect webhooks. The biggest difference is product focus:
          webhooks.cc is built around developer workflows in CLI, SDK, and AI-assisted tooling.
        </p>

        <div className="neo-code overflow-x-auto mb-8">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-foreground">
                <th scope="col" className="text-left py-2 pr-3">
                  Category
                </th>
                <th scope="col" className="text-left py-2 pr-3">
                  webhooks.cc
                </th>
                <th scope="col" className="text-left py-2">
                  Webhook.site
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([label, left, right]) => (
                <tr key={label} className="border-b border-foreground/20 last:border-0">
                  <td className="py-2 pr-3 font-semibold">{label}</td>
                  <td className="py-2 pr-3">{left}</td>
                  <td className="py-2">{right}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="text-2xl font-bold mb-3">When webhooks.cc is the better fit</h2>
        <ul className="list-disc list-inside text-muted-foreground space-y-1 mb-8">
          <li>You want webhook assertions directly inside Vitest/Jest tests.</li>
          <li>You prefer terminal-first development with a native CLI flow.</li>
          <li>You want AI coding agents to create/send/inspect/replay through MCP.</li>
          <li>You want all core features on free and paid without feature gating.</li>
        </ul>

        <div className="flex flex-wrap gap-3">
          <Link href="/go" className="neo-btn-primary">
            Try webhooks.cc
          </Link>
          <Link href="/compare" className="neo-btn-outline">
            More comparisons
          </Link>
        </div>
      </article>
    </main>
  );
}
