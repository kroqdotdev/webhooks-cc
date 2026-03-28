import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best Beeceptor alternatives in 2026?",
    answer:
      "webhooks.cc is a strong Beeceptor alternative if your focus is webhook testing rather than API mocking. It captures real webhook payloads with replay, a TypeScript SDK for CI assertions, and an MCP server for AI agents. Other alternatives include Webhook.site (browser-based inspection), RequestBin/Pipedream (workflow automation), and Hookdeck (production infrastructure).",
  },
  {
    question: "What is the difference between webhooks.cc and Beeceptor?",
    answer:
      "Beeceptor is primarily an API mocking and interception tool — you define mock API endpoints with rules that return canned responses. webhooks.cc is a webhook testing platform — you capture real incoming webhooks, inspect them, replay them, and assert on payloads in automated tests. Both can inspect HTTP requests, but the workflows they optimize for differ.",
  },
  {
    question: "Can Beeceptor test webhooks?",
    answer:
      "Beeceptor can capture incoming requests and display them, similar to webhook inspection. However, it does not provide a TypeScript SDK for automated test assertions, an MCP server for AI agents, or purpose-built CLI tunneling for webhook development workflows.",
  },
  {
    question: "Does webhooks.cc support API mocking?",
    answer:
      "webhooks.cc supports mock responses — you configure a status code, headers, and body that get returned to the webhook sender. This is useful for simulating your server's response during webhook integration testing. For full API mocking with routing rules and proxy interception, Beeceptor is more comprehensive.",
  },
  {
    question: "Which tool is better for CI/CD webhook testing?",
    answer:
      "webhooks.cc. Its TypeScript SDK provides waitFor() with request matchers for method, headers, and JSON body paths. You can create a test endpoint, trigger your webhook sender, and assert on the captured payload inside Vitest or Jest — no mocking server required.",
  },
];

const ROWS = [
  ["Primary focus", "Webhook testing & inspection", "API mocking & interception"],
  ["Webhook capture & history", "Yes — full request storage", "Yes — request logging"],
  ["Mock responses", "Yes — per-endpoint config", "Yes — rule-based routing"],
  ["API mocking / proxy rules", "No", "Yes — core feature"],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "No native CLI"],
  ["TypeScript SDK", "Yes — @webhooks-cc/sdk", "No"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  ["MCP server for AI agents", "Yes — @webhooks-cc/mcp", "No"],
  ["Request replay", "Yes", "No"],
  ["Real-time SSE streaming", "Yes", "No"],
  ["CORS proxy", "No", "Yes"],
  ["Open source", "Yes (AGPL + MIT)", "No"],
  ["Team collaboration", "Pro ($8/mo), up to 25 members", "Team+ ($25/mo), unlimited members"],
  ["Free tier features", "Everything except Teams", "Limited endpoints + requests"],
] as const;

export const metadata = createPageMetadata({
  title: "Beeceptor Alternative for Webhook Testing (2026)",
  description:
    "Comparing Beeceptor alternatives? webhooks.cc focuses on webhook testing with inspection, replay, a TypeScript SDK for CI, and an MCP server for AI agents. Every feature on both tiers — only Teams requires Pro.",
  path: "/compare/beeceptor",
  keywords: [
    "beeceptor alternative",
    "beeceptor alternatives",
    "best beeceptor alternative",
    "webhooks.cc vs beeceptor",
    "webhook testing tool",
    "api mocking vs webhook testing",
    "beeceptor webhook",
    "webhook inspection tool",
  ],
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
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison · Updated March 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Beeceptor</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you&apos;re looking for a Beeceptor alternative focused on webhook testing, webhooks.cc
          captures real payloads, replays them, and lets you assert on them in automated tests.
          Beeceptor excels at API mocking — define rules, return canned responses, proxy requests.
          Both inspect HTTP requests, but they solve different problems.
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
                  Beeceptor
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
            <h3 className="text-lg font-bold mb-2">API mocking vs webhook inspection</h3>
            <p className="text-muted-foreground">
              Beeceptor&apos;s strength is simulating APIs you depend on — define URL patterns, set
              response rules, proxy traffic to real backends. webhooks.cc does the opposite: it
              receives real webhooks from services you integrate with (Stripe, GitHub, Twilio) and
              gives you tools to inspect, search, replay, and assert on those payloads.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Developer tooling depth</h3>
            <p className="text-muted-foreground">
              webhooks.cc provides three integration layers beyond the dashboard: a CLI for
              tunneling webhooks to localhost, a TypeScript SDK for programmatic access and CI
              assertions, and an MCP server for AI coding agents. Team collaboration on webhooks.cc
              starts at $8/month with up to 25 members, while Beeceptor&apos;s Team+ plan costs
              $25/month. Beeceptor is browser-first with API access on paid plans.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Request replay</h3>
            <p className="text-muted-foreground">
              webhooks.cc lets you replay any captured request to a target URL — useful for
              re-triggering webhook handlers during debugging without asking the sender to resend.
              Beeceptor focuses on request logging rather than replay workflows.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Capture and inspect real webhook payloads from live services</li>
              <li>Replay requests to re-trigger webhook handlers</li>
              <li>SDK assertions for webhook payloads in CI</li>
              <li>MCP integration for AI coding agent workflows</li>
              <li>CLI tunnel that captures + forwards in one step</li>
            </ul>
          </div>
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose Beeceptor when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Full API mocking with routing rules and conditions</li>
              <li>Proxy interception between your app and external APIs</li>
              <li>CORS proxy for frontend development</li>
              <li>Simulating APIs that don&apos;t exist yet</li>
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
            href="/compare/webhook-site"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Webhook.site
          </Link>
          {" · "}
          <Link
            href="/compare/requestbin"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs RequestBin
          </Link>
          {" · "}
          <Link
            href="/compare/ngrok"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs ngrok
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
