import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best Smee.io alternatives in 2026?",
    answer:
      "webhooks.cc is a strong Smee.io alternative that adds persistent request history, replay, a TypeScript SDK for CI test assertions, and an MCP server for AI agents on top of localhost forwarding. Other alternatives include ngrok (general-purpose tunnel), LocalTunnel (free open-source tunnel), and Webhook.site (browser-based inspection).",
  },
  {
    question: "What is Smee.io?",
    answer:
      "Smee.io is a webhook proxy created by GitHub. It receives webhooks and forwards them to your local development server using a Server-Sent Events (SSE) connection. It was built primarily for GitHub App development, where you need to receive GitHub webhooks on localhost.",
  },
  {
    question: "What is the difference between webhooks.cc and Smee.io?",
    answer:
      "Smee.io is a minimal webhook proxy — it forwards payloads to localhost in real time but does not store request history, offer search, provide replay, or support test assertions. webhooks.cc is a full webhook testing platform with persistent request storage, a dashboard, CLI tunnel, TypeScript SDK, MCP server, and mock response configuration.",
  },
  {
    question: "Is Smee.io free?",
    answer:
      "Yes, Smee.io is free and open source. webhooks.cc also has a free tier with all features included. The webhooks.cc paid plan raises rate limits and retention.",
  },
  {
    question: "Should I use Smee.io or webhooks.cc for GitHub App development?",
    answer:
      "Either works for forwarding GitHub webhooks to localhost. Smee.io was purpose-built for this and is the simplest option if forwarding is all you need. webhooks.cc adds request history, payload inspection, replay, and SDK assertions — useful if you want to inspect GitHub webhook payloads in detail or write automated tests for your GitHub App's webhook handler.",
  },
];

const ROWS = [
  ["Primary purpose", "Webhook testing platform", "Webhook proxy for localhost"],
  ["Webhook forwarding to localhost", "Yes (CLI tunnel)", "Yes (SSE client)"],
  ["Request history & storage", "Yes — persistent, searchable", "No — session only"],
  ["Request inspection dashboard", "Yes", "Minimal (channel page)"],
  ["Mock responses", "Yes — per endpoint", "No"],
  ["Request replay", "Yes — to any URL", "No"],
  ["Search & filtering", "Yes", "No"],
  ["Export (JSON / CSV)", "Yes", "No"],
  ["TypeScript SDK", "Yes — @webhooks-cc/sdk", "No"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  ["MCP server for AI agents", "Yes — @webhooks-cc/mcp", "No"],
  ["Auth / user accounts", "Yes (optional)", "No — anonymous channels"],
  ["Open source", "Yes (AGPL + MIT)", "Yes (ISC)"],
  ["Free tier", "All features, rate-limited", "Free (fully open)"],
] as const;

export const metadata = createPageMetadata({
  title: "Smee.io Alternative with Full Webhook Testing (2026)",
  description:
    "Looking for a Smee.io alternative? webhooks.cc adds persistent history, replay, TypeScript SDK for CI assertions, and MCP for AI agents on top of localhost forwarding. Free and open source.",
  path: "/compare/smee",
  keywords: [
    "smee.io alternative",
    "smee alternative",
    "smee.io alternatives",
    "best smee alternative",
    "webhooks.cc vs smee",
    "smee webhook proxy",
    "github webhook testing",
    "github app webhook development",
    "webhook localhost forwarding",
  ],
});

export default function CompareSmeeePage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Smee.io", path: "/compare/smee" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison · Updated March 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Smee.io</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you&apos;ve outgrown Smee.io and need more than a simple proxy, webhooks.cc is a full
          webhook testing platform — it captures, stores, inspects, replays, and lets you write
          automated assertions on webhook payloads. Smee.io forwards payloads to localhost over SSE.
          Smee is simpler; webhooks.cc does more.
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
                  Smee.io
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
            <h3 className="text-lg font-bold mb-2">Proxy vs platform</h3>
            <p className="text-muted-foreground">
              Smee.io does one thing: forward incoming webhooks to your local machine via SSE. It does
              not store request history, offer search, or provide replay. When you close the browser
              tab, the data is gone. webhooks.cc stores every request with full headers, body, and
              metadata — searchable, exportable, and replayable from the dashboard, CLI, or SDK.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Developer tooling</h3>
            <p className="text-muted-foreground">
              webhooks.cc provides a TypeScript SDK for programmatic access and CI test assertions, a
              native CLI with built-in tunneling, and an MCP server for AI coding agents. Smee.io
              provides a small npm client (<code className="text-sm bg-muted px-1.5 py-0.5">smee-client</code>)
              for forwarding — no SDK, no test helpers, no MCP.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">GitHub App development</h3>
            <p className="text-muted-foreground">
              Smee.io was built specifically for GitHub App webhook development and is recommended in
              GitHub&apos;s docs. It works well for that narrow use case. If you need to go beyond
              forwarding — inspect payloads across multiple webhook sources, replay failed deliveries,
              or assert on GitHub event payloads in tests — webhooks.cc covers the broader workflow.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Persistent request history with search and export</li>
              <li>Replay captured webhooks against your handler</li>
              <li>SDK assertions in automated test suites</li>
              <li>Mock responses returned to webhook senders</li>
              <li>MCP integration for AI-assisted development</li>
              <li>Multiple webhook sources beyond GitHub</li>
            </ul>
          </div>
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose Smee.io when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>The simplest possible localhost forwarding</li>
              <li>Quick GitHub App development with zero setup</li>
              <li>No account, no auth — just a URL and a client</li>
              <li>Open-source proxy you can self-host</li>
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
          <Link
            href="/compare/localtunnel"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs LocalTunnel
          </Link>
          {" · "}
          <Link href="/compare/ngrok" className="font-semibold hover:text-primary transition-colors">
            vs ngrok
          </Link>
          {" · "}
          <Link
            href="/compare/webhook-site"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Webhook.site
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
