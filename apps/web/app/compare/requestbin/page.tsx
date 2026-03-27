import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best RequestBin alternatives in 2026?",
    answer:
      "webhooks.cc is a strong RequestBin alternative for developers who want focused webhook testing without workflow automation. It offers webhook capture, replay, a TypeScript SDK for CI assertions, a CLI tunnel, and an MCP server — all open source. Other alternatives include Webhook.site (browser-based inspection), Beeceptor (API mocking), and Hookdeck (production webhook infrastructure).",
  },
  {
    question: "Is RequestBin still available as a standalone tool?",
    answer:
      "The original RequestBin was open source and self-hostable. It was acquired by Pipedream and now lives inside Pipedream's workflow platform. You can still capture requests, but the product has shifted toward workflow automation — triggers, steps, and integrations — rather than standalone webhook inspection.",
  },
  {
    question: "What is the difference between webhooks.cc and RequestBin?",
    answer:
      "webhooks.cc is a focused webhook testing platform: capture, inspect, replay, mock, tunnel to localhost, and assert on payloads in automated tests. RequestBin (Pipedream) captures requests as workflow triggers — the emphasis is on what happens after the webhook arrives (run code, call APIs, transform data). If you just need to test and debug webhooks, webhooks.cc is simpler. If you need workflow automation, Pipedream is more capable.",
  },
  {
    question: "Does webhooks.cc have workflow automation like Pipedream?",
    answer:
      "No. webhooks.cc does not chain actions, call third-party APIs, or run code in response to webhooks. It is a testing and development tool: capture, inspect, replay, assert. For production webhook processing with workflow steps, Pipedream or similar platforms are the right choice.",
  },
  {
    question: "Can I self-host webhooks.cc like the original RequestBin?",
    answer:
      "webhooks.cc is open source (AGPL-3.0 for the web app and receiver, MIT for the CLI, SDK, and MCP server). You can self-host the full stack. The original RequestBin was also open source, but the Pipedream version is not self-hostable.",
  },
];

const ROWS = [
  ["Primary focus", "Webhook testing & inspection", "Workflow automation platform"],
  ["Webhook capture", "Yes — full request storage", "Yes — as workflow trigger"],
  ["Request inspection UI", "Yes — dedicated dashboard", "Yes — within workflow editor"],
  ["Mock responses", "Yes — configurable per endpoint", "Yes — via workflow code"],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "No"],
  ["TypeScript SDK", "Yes — @webhooks-cc/sdk", "No webhook-specific SDK"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  ["MCP server for AI agents", "Yes — @webhooks-cc/mcp", "No"],
  ["Request replay", "Yes", "No (re-trigger workflow)"],
  ["Workflow automation", "No", "Yes — core feature"],
  ["Third-party integrations", "No", "Yes — 1000+ apps"],
  ["Self-hostable", "Yes (open source)", "No"],
  ["Free tier", "All features, rate-limited", "Limited invocations/day"],
] as const;

export const metadata = createPageMetadata({
  title: "RequestBin Alternative — Open Source & Free (2026)",
  description:
    "Looking for a RequestBin alternative? webhooks.cc is an open-source webhook testing tool with inspection, replay, TypeScript SDK, CLI tunnel, and MCP server. Free tier, no credit card.",
  path: "/compare/requestbin",
  keywords: [
    "requestbin alternative",
    "requestbin alternatives",
    "best requestbin alternative",
    "pipedream requestbin alternative",
    "webhooks.cc vs requestbin",
    "requestbin replacement",
    "requestbin self-hosted alternative",
    "webhook capture tool",
    "webhook testing tool",
  ],
});

export default function CompareRequestBinPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs RequestBin", path: "/compare/requestbin" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison · Updated March 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">
          webhooks.cc vs RequestBin (Pipedream)
        </h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you&apos;re looking for a RequestBin alternative, webhooks.cc picks up where the original
          RequestBin left off: a focused tool for capturing, inspecting, replaying, and testing
          webhooks. RequestBin now lives inside Pipedream as a workflow automation platform.
          webhooks.cc stays developer-first with a CLI, TypeScript SDK, and MCP server.
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
                  RequestBin (Pipedream)
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
            <h3 className="text-lg font-bold mb-2">Testing tool vs automation platform</h3>
            <p className="text-muted-foreground">
              webhooks.cc is built for development and testing: capture a webhook from Stripe, inspect
              the payload, replay it against your handler, write SDK assertions in CI. RequestBin
              (Pipedream) is built for production automation: receive a webhook, transform the data,
              call downstream APIs, store results. They solve adjacent but different problems.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Developer tooling</h3>
            <p className="text-muted-foreground">
              webhooks.cc includes a native CLI for tunneling webhooks to localhost, a TypeScript SDK
              with <code className="text-sm bg-muted px-1.5 py-0.5">waitFor()</code> for test
              assertions, and an MCP server for AI agent integration. RequestBin focuses on the
              Pipedream workflow editor and API — it does not offer webhook-specific dev tooling.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Open source and self-hosting</h3>
            <p className="text-muted-foreground">
              webhooks.cc is fully open source. You can self-host the web app, receiver, CLI, SDK, and
              MCP server. The original RequestBin was also open source, but the Pipedream version is a
              hosted platform without a self-host option.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A focused webhook testing and debugging tool</li>
              <li>Request replay for re-triggering handlers</li>
              <li>SDK assertions in CI test suites</li>
              <li>CLI tunnel for local webhook development</li>
              <li>Self-hosted, open-source deployment</li>
            </ul>
          </div>
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose RequestBin (Pipedream) when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Workflow automation triggered by webhooks</li>
              <li>Integrations with 1000+ third-party apps</li>
              <li>Code execution steps after webhook receipt</li>
              <li>Production webhook processing, not just testing</li>
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
            href="/compare/beeceptor"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Beeceptor
          </Link>
          {" · "}
          <Link
            href="/compare/hookdeck"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Hookdeck
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
