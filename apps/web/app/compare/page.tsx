import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "Webhook Testing Tool Alternatives (2026)",
  description:
    "Compare webhooks.cc against Webhook.site, ngrok, Beeceptor, RequestBin, Hookdeck, Smee.io, and LocalTunnel. Honest feature tables, tradeoffs, and when to use each tool.",
  path: "/compare",
  keywords: [
    "webhook testing tool comparison",
    "webhook testing alternatives",
    "webhook.site alternative",
    "ngrok alternative",
    "requestbin alternative",
    "beeceptor alternative",
    "hookdeck alternative",
    "smee.io alternative",
    "localtunnel alternative",
    "webhook inspection tools",
  ],
});

const COMPARISONS = [
  {
    href: "/compare/webhook-site",
    title: "webhooks.cc vs Webhook.site",
    summary:
      "Both capture webhooks. webhooks.cc adds an SDK for CI assertions, MCP for AI agents, and no feature gating on the free tier.",
  },
  {
    href: "/compare/ngrok",
    title: "webhooks.cc vs ngrok",
    summary:
      "ngrok is a general-purpose tunnel. webhooks.cc is a webhook testing platform with capture, replay, SDK, and MCP built in.",
  },
  {
    href: "/compare/requestbin",
    title: "webhooks.cc vs RequestBin (Pipedream)",
    summary:
      "RequestBin evolved into a workflow automation platform. webhooks.cc stays focused on webhook testing and developer tooling.",
  },
  {
    href: "/compare/beeceptor",
    title: "webhooks.cc vs Beeceptor",
    summary:
      "Beeceptor excels at API mocking. webhooks.cc excels at capturing and testing real webhook payloads with SDK and MCP.",
  },
  {
    href: "/compare/hookdeck",
    title: "webhooks.cc vs Hookdeck",
    summary:
      "Hookdeck is production webhook infrastructure (retries, routing). webhooks.cc is a development testing tool. They complement each other.",
  },
  {
    href: "/compare/smee",
    title: "webhooks.cc vs Smee.io",
    summary:
      "Smee.io is a minimal webhook proxy by GitHub. webhooks.cc adds persistent history, replay, SDK assertions, and MCP on top of forwarding.",
  },
  {
    href: "/compare/localtunnel",
    title: "webhooks.cc vs LocalTunnel",
    summary:
      "LocalTunnel is a free, simple tunnel. webhooks.cc tunnels too — and also captures, inspects, replays, and tests every request.",
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
          Honest, developer-focused comparisons against popular webhook testing alternatives. Each
          page covers features, tradeoffs, and when to choose each tool.
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
