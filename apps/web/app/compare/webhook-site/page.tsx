import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best Webhook.site alternatives in 2026?",
    answer:
      "webhooks.cc is a strong Webhook.site alternative for developers who need automated webhook testing. It adds a TypeScript SDK with test assertions, a native CLI tunnel, an MCP server for AI coding agents, and a free tier with no feature gating. Other alternatives include Beeceptor (API mocking focus), RequestBin/Pipedream (workflow automation), and Hookdeck (production webhook infrastructure).",
  },
  {
    question: "What is the main difference between webhooks.cc and Webhook.site?",
    answer:
      "Both tools capture and inspect incoming webhooks. webhooks.cc adds a TypeScript SDK for writing webhook assertions in automated tests, a native CLI for tunneling to localhost, and an MCP server so AI coding agents can create, inspect, and replay webhooks programmatically.",
  },
  {
    question: "Does webhooks.cc have a free plan like Webhook.site?",
    answer:
      "Yes. webhooks.cc offers a free tier with all core features — inspection, replay, mock responses, CLI tunnel, SDK, and MCP. The paid plan raises rate limits and extends request retention. No features are locked behind a paywall.",
  },
  {
    question: "Can I use webhooks.cc for CI/CD webhook testing?",
    answer:
      "Yes. The TypeScript SDK provides a waitFor() method that polls for incoming requests with configurable matchers (method, headers, body fields). You can assert on webhook payloads directly inside Vitest or Jest test suites.",
  },
  {
    question: "Does Webhook.site have an SDK or MCP server?",
    answer:
      "Webhook.site offers an API but no first-party TypeScript SDK with test assertion helpers. It also does not provide an MCP server for AI coding agent integration.",
  },
];

const ROWS = [
  ["Webhook capture & inspection", "Yes", "Yes"],
  ["Mock responses", "Yes", "Yes (paid)"],
  ["Request replay", "Yes", "Yes"],
  ["Search & filtering", "Yes", "Yes"],
  ["Export (JSON / CSV)", "Yes", "Yes"],
  ["CLI tunnel to localhost", "Yes", "Yes"],
  ["TypeScript SDK", "Yes — @webhooks-cc/sdk", "No first-party SDK"],
  ["CI test assertions (waitFor)", "Yes", "No"],
  ["MCP server for AI agents", "Yes — @webhooks-cc/mcp", "No"],
  ["Request body matchers", "Yes (method, header, body path)", "No"],
  ["SSE real-time streaming", "Yes", "No"],
  ["Open source", "Yes (AGPL + MIT)", "No"],
  ["Free tier feature gating", "None — all features included", "Some features paid-only"],
] as const;

export const metadata = createPageMetadata({
  title: "Webhook.site Alternative — Full Comparison (2026)",
  description:
    "Looking for a Webhook.site alternative? webhooks.cc adds a TypeScript SDK for CI testing, a CLI tunnel, and an MCP server for AI agents. Free tier with all features — no credit card required.",
  path: "/compare/webhook-site",
  keywords: [
    "webhook.site alternative",
    "webhook.site alternatives",
    "best webhook.site alternative",
    "webhooks.cc vs webhook.site",
    "webhook testing tool",
    "webhook inspection tool",
    "webhook sdk",
    "webhook mcp server",
    "webhook cli tunnel",
  ],
});

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
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison · Updated March 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Webhook.site</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you&apos;re evaluating Webhook.site alternatives, here&apos;s the short version: both
          tools capture and inspect webhooks. webhooks.cc goes further with a TypeScript SDK for CI
          test assertions, a CLI tunnel for local development, and an MCP server for AI-assisted
          workflows — all on a free tier with no feature gating.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <div className="neo-code overflow-x-auto mb-10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-foreground">
                <th scope="col" className="text-left py-2.5 pr-4 font-bold">
                  Feature
                </th>
                <th scope="col" className="text-left py-2.5 pr-4 font-bold">
                  webhooks.cc
                </th>
                <th scope="col" className="text-left py-2.5 font-bold">
                  Webhook.site
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([label, left, right]) => (
                <tr key={label} className="border-b border-foreground/20 last:border-0">
                  <td className="py-2.5 pr-4 font-medium">{label}</td>
                  <td className="py-2.5 pr-4">{left}</td>
                  <td className="py-2.5">{right}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">SDK for automated testing</h3>
            <p className="text-muted-foreground">
              webhooks.cc publishes{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5">@webhooks-cc/sdk</code> on npm. Use{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5">waitFor()</code> to poll for incoming
              requests during integration tests, match on method, headers, or JSON body paths, and
              assert directly in Vitest or Jest. Webhook.site offers an API but no first-party SDK
              with built-in test helpers.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">MCP server for AI agents</h3>
            <p className="text-muted-foreground">
              <code className="text-sm bg-muted px-1.5 py-0.5">@webhooks-cc/mcp</code> exposes 11
              tools — create endpoints, send test payloads, inspect captured requests, replay, and
              more — so Cursor, Claude Code, Windsurf, or any MCP-compatible agent can drive webhook
              workflows without leaving the editor. Webhook.site does not offer MCP support.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Pricing model</h3>
            <p className="text-muted-foreground">
              webhooks.cc includes every feature on both free and paid tiers. The paid plan raises
              request limits and extends retention — it does not unlock features. Webhook.site gates
              some features (custom responses, API access) behind paid tiers.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Webhook assertions in CI pipelines (SDK waitFor)</li>
              <li>AI agents that create, inspect, and replay webhooks (MCP)</li>
              <li>A CLI tunnel purpose-built for webhook forwarding</li>
              <li>All features available on the free tier</li>
              <li>Open-source codebase you can inspect and self-host</li>
            </ul>
          </div>
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose Webhook.site when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A well-established tool with a large existing user base</li>
              <li>Quick browser-only inspection with no install</li>
              <li>Familiarity — your team already uses it</li>
            </ul>
          </div>
        </div>

        {/* FAQ */}
        <h2 className="text-2xl font-bold mb-4">Frequently asked questions</h2>
        <div className="space-y-4 mb-4">
          {FAQ_ITEMS.map((item) => (
            <div key={item.question} className="neo-card neo-card-static">
              <h3 className="font-bold mb-2">{item.question}</h3>
              <p className="text-muted-foreground text-sm">{item.answer}</p>
            </div>
          ))}
        </div>

        {/* More comparisons */}
        <p className="text-sm text-muted-foreground mb-0">
          See also:{" "}
          <Link href="/compare/ngrok" className="font-semibold hover:text-primary transition-colors">
            vs ngrok
          </Link>
          {" · "}
          <Link
            href="/compare/beeceptor"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Beeceptor
          </Link>
          {" · "}
          <Link
            href="/compare/requestbin"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs RequestBin
          </Link>
          {" · "}
          <Link href="/compare" className="font-semibold hover:text-primary transition-colors">
            All comparisons
          </Link>
        </p>

        {/* CTA */}
        <ComparisonCTA />
      </article>
    </main>
  );
}
