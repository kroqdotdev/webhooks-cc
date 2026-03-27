import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best Hookdeck alternatives in 2026?",
    answer:
      "It depends on what you need. If you need a webhook development and testing tool, webhooks.cc is a strong alternative — it captures, inspects, and replays webhooks with SDK assertions and MCP tooling. If you need production webhook infrastructure with retries and routing, alternatives include Svix and cloud-native solutions like AWS EventBridge. webhooks.cc and Hookdeck are complementary tools — one for development, one for production.",
  },
  {
    question: "What is the difference between webhooks.cc and Hookdeck?",
    answer:
      "Hookdeck is webhook infrastructure for production — it sits between webhook senders and your server, handling retries, rate limiting, routing, and delivery guarantees. webhooks.cc is a development and testing tool — it captures webhooks so you can inspect, replay, and assert on payloads during development and CI. Hookdeck solves reliability in production. webhooks.cc solves visibility during development.",
  },
  {
    question: "Can I use webhooks.cc and Hookdeck together?",
    answer:
      "Yes. You can use webhooks.cc during development to capture and test webhook payloads, then use Hookdeck in production for reliable delivery and retry logic. They address different phases of the webhook lifecycle.",
  },
  {
    question: "Does Hookdeck have a free tier?",
    answer:
      "Yes. Hookdeck offers a free tier with limited events per month. webhooks.cc also offers a free tier with all features included — the paid plan raises rate limits and retention, not feature access.",
  },
  {
    question: "Does webhooks.cc handle webhook retries and delivery guarantees?",
    answer:
      "No. webhooks.cc is a testing tool — it captures and stores incoming webhooks for inspection, replay, and automated assertions. It does not sit in your production webhook delivery path. For production reliability (retries, rate limiting, dead-letter queues), Hookdeck or a similar infrastructure tool is the right choice.",
  },
];

const ROWS = [
  ["Primary focus", "Webhook testing & development", "Webhook infrastructure & reliability"],
  ["Webhook capture & inspection", "Yes — core feature", "Yes — event log"],
  ["Retry & delivery guarantees", "No", "Yes — core feature"],
  ["Rate limiting & throttling", "No", "Yes"],
  ["Webhook routing & fan-out", "No", "Yes"],
  ["Dead-letter queue", "No", "Yes"],
  ["Mock responses", "Yes — per endpoint", "No"],
  ["Request replay", "Yes — to any URL", "Yes — redelivery"],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "Yes (hookdeck listen)"],
  ["TypeScript SDK", "Yes — test assertions", "Yes — infrastructure API"],
  ["CI test assertions (waitFor)", "Yes", "No"],
  ["MCP server for AI agents", "Yes — @webhooks-cc/mcp", "No"],
  ["Open source", "Yes (AGPL + MIT)", "Partially"],
  ["Free tier", "All features, rate-limited", "Limited events/month"],
] as const;

export const metadata = createPageMetadata({
  title: "Hookdeck Alternative for Dev & Testing (2026)",
  description:
    "Evaluating Hookdeck alternatives for webhook development? webhooks.cc handles testing with inspection, replay, SDK assertions, and MCP for AI agents. Free tier, all features included.",
  path: "/compare/hookdeck",
  keywords: [
    "hookdeck alternative",
    "hookdeck alternatives",
    "best hookdeck alternative",
    "webhooks.cc vs hookdeck",
    "webhook testing tool",
    "webhook infrastructure alternative",
    "webhook development tool",
    "webhook testing vs infrastructure",
  ],
});

export default function CompareHookdeckPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Hookdeck", path: "/compare/hookdeck" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison · Updated March 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Hookdeck</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Looking for a Hookdeck alternative for webhook development and testing? webhooks.cc
          captures webhooks, inspects payloads, replays requests, and lets you write automated test
          assertions. Hookdeck handles production infrastructure — retries, rate limiting, routing,
          and delivery guarantees. They solve different problems and work well together.
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
                  Hookdeck
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
            <h3 className="text-lg font-bold mb-2">Development testing vs production reliability</h3>
            <p className="text-muted-foreground">
              webhooks.cc captures every incoming webhook and makes it available for inspection,
              search, export, and replay. Its SDK lets you assert on payloads in CI test suites.
              Hookdeck sits in your production webhook delivery path — it receives webhooks, applies
              retries, rate limiting, and routing rules, then delivers them to your server. One is for
              building; the other is for running.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">AI agent integration</h3>
            <p className="text-muted-foreground">
              webhooks.cc provides an MCP server with 11 tools for AI coding agents — create
              endpoints, send test payloads, inspect responses, replay requests. This lets agents like
              Cursor, Claude Code, and Windsurf handle webhook testing without manual dashboard
              interaction. Hookdeck does not offer MCP integration.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Complementary tools</h3>
            <p className="text-muted-foreground">
              These tools are not mutually exclusive. A common pattern: use webhooks.cc during
              development to capture and debug webhook payloads, write SDK assertions in your test
              suite, then use Hookdeck in production for reliable delivery with retries and
              rate limiting.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Inspect and debug webhook payloads during development</li>
              <li>Write automated test assertions on webhook content</li>
              <li>Replay captured requests against your handler</li>
              <li>AI agent tooling for webhook workflows (MCP)</li>
              <li>Mock responses returned to webhook senders</li>
            </ul>
          </div>
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose Hookdeck when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Production webhook reliability with retries</li>
              <li>Rate limiting and throttling for high-volume webhooks</li>
              <li>Webhook routing and fan-out to multiple destinations</li>
              <li>Dead-letter queues for failed deliveries</li>
              <li>Infrastructure-grade webhook management</li>
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
            href="/compare/requestbin"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs RequestBin
          </Link>
          {" · "}
          <Link
            href="/compare/webhook-site"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Webhook.site
          </Link>
          {" · "}
          <Link href="/compare/ngrok" className="font-semibold hover:text-primary transition-colors">
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
