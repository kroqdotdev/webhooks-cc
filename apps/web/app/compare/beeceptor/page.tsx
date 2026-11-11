import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best Beeceptor alternatives in 2026?",
    answer:
      "webhooks.cc is a strong Beeceptor alternative if your focus is webhook testing rather than API mocking. It captures real webhook payloads and email with replay, SDKs for CI assertions in TypeScript, Python and Go, and an MCP server for AI agents. Other alternatives include Webhook.site (browser-based inspection) and Hookdeck (production infrastructure).",
  },
  {
    question: "What is the difference between webhooks.cc and Beeceptor?",
    answer:
      "Beeceptor is primarily an API mocking and interception tool: you define mock API endpoints with rules that return canned responses. webhooks.cc is a webhook testing platform: you capture real incoming webhooks and email, inspect them, replay them, forward them, and assert on payloads in automated tests. Both can inspect HTTP requests, but the workflows they optimize for differ.",
  },
  {
    question: "Can Beeceptor test webhooks?",
    answer:
      "Beeceptor can capture incoming requests and display them, similar to webhook inspection, and its CLI (beeceptor-cli) can tunnel an endpoint to localhost. It does not provide an SDK for automated test assertions (CI integration goes through its management API on the Team plan and up), and request history needs the Team plan or higher. Its MCP server is built around mock rules and request history.",
  },
  {
    question: "Does webhooks.cc support API mocking?",
    answer:
      "Partly. webhooks.cc mock responses set the status code, headers, and body returned to the sender, and response rules pick a different answer by method, path, headers, query or body, with placeholders that fill in values from the request. That covers simulating your server's response during webhook integration testing. For full API mocking with stateful rules and proxy interception, Beeceptor is more comprehensive.",
  },
  {
    question: "Which tool is better for CI/CD webhook testing?",
    answer:
      "webhooks.cc. Its TypeScript SDK provides waitFor() with request matchers for method, headers, and JSON body paths, and the Python and Go SDKs do the same. You can create a test endpoint, trigger your webhook sender, and assert on the captured payload inside Vitest, Jest, pytest or go test, with no mocking server required.",
  },
  {
    question: "Does Beeceptor capture webhooks?",
    answer:
      "Yes. A Beeceptor endpoint logs incoming requests, so you can point a webhook at it and read the payload, and its rules can return mock responses. It is built mainly for API mocking. webhooks.cc is built around webhooks: stored history, replay, built-in signature verification for Stripe, GitHub, Shopify, Clerk and many more, a CLI tunnel to localhost and SDK assertions in CI.",
  },
];

const ROWS = [
  ["Primary focus", "Webhook & email testing", "API mocking & interception"],
  ["Webhook capture & history", "Yes, full request storage", "Yes, history on Team and up"],
  ["Mock responses", "Yes, rule-based with placeholders", "Yes, rule-based routing"],
  ["API mocking / proxy rules", "Response rules, no proxy", "Yes, core feature"],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "Yes (beeceptor-cli)"],
  ["SDKs", "TypeScript, Python and Go", "No (management API)"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  [
    "MCP server for AI agents",
    "Yes, remote (OAuth) or local",
    "Yes, remote (OAuth), for mock rules",
  ],
  ["Request replay", "Yes, to any URL", "Not documented"],
  ["Inbound email capture", "Yes, {slug}@mailhooks.cc or your own domain", "No"],
  ["Real-time SSE streaming", "Yes", "No"],
  ["CORS proxy", "No", "Yes"],
  ["Open source", "Yes (AGPL + MIT)", "No"],
  ["Team collaboration", "From $12/seat/mo, pooled quota", "Team ($25/mo), unlimited members"],
  ["Free tier features", "Every Pro feature", "3 rules, limited requests"],
] as const;

export const metadata = createPageMetadata({
  title: "Beeceptor Alternative for Webhook Testing (2026)",
  description:
    "Beeceptor alternative focused on webhook and email testing. Inspect, replay, and assert on payloads with SDKs for TypeScript, Python and Go, a CLI tunnel, and MCP.",
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
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Beeceptor", path: "/compare/beeceptor" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Beeceptor</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you&apos;re looking for a Beeceptor alternative focused on webhook testing, webhooks.cc
          captures real payloads, replays them, and lets you assert on them in automated tests.
          Beeceptor excels at API mocking: define rules, return canned responses, proxy requests.
          Both inspect HTTP requests, but they solve different problems.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <div className="ui-code overflow-x-auto mb-10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
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
          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">API mocking vs webhook inspection</h3>
            <p className="text-muted-foreground">
              Beeceptor&apos;s strength is simulating APIs you depend on: define URL patterns, set
              response rules, proxy traffic to real backends. webhooks.cc does the opposite: it
              receives real webhooks from services you integrate with (Stripe, GitHub, Twilio), and
              email at its own addresses, and gives you tools to inspect, search, replay, forward,
              and assert on those payloads. Its response rules answer the sender, but it does not
              proxy traffic to a backend.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Developer tooling depth</h3>
            <p className="text-muted-foreground">
              webhooks.cc provides three integration layers beyond the dashboard: a CLI for
              tunneling webhooks to localhost, SDKs for TypeScript, Python and Go for programmatic
              access and CI assertions, and an MCP server for AI coding agents. Beeceptor has a CLI
              tunnel and a remote MCP server too, built around its mock rules, and offers its
              management API for CI on the Team plan and up. Team collaboration on webhooks.cc costs
              $12/seat/month, with each seat adding 100,000 pooled requests, while Beeceptor&apos;s
              Team plan costs $25/month.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Request replay</h3>
            <p className="text-muted-foreground">
              webhooks.cc lets you replay any captured request to a target URL, useful for
              re-triggering webhook handlers during debugging without asking the sender to resend.
              Beeceptor focuses on request logging (exported as HAR) rather than replay workflows.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Capture and inspect real webhook payloads from live services</li>
              <li>Replay requests to re-trigger webhook handlers</li>
              <li>SDK assertions for webhook payloads in CI</li>
              <li>MCP integration for AI coding agent workflows</li>
              <li>CLI tunnel that captures + forwards in one step</li>
              <li>Email capture alongside webhooks, parsed and forwarded as JSON</li>
            </ul>
          </div>
          <div className="ui-card ui-card-static">
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
            <div key={item.question} className="ui-card ui-card-static">
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
