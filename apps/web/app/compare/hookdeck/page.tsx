import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best Hookdeck alternatives in 2026?",
    answer:
      "It depends on what you need. If you need a webhook development and testing tool, webhooks.cc is a strong alternative: it captures, inspects, and replays webhooks and email with SDK assertions and MCP tooling. If you need production webhook infrastructure with retries and routing, alternatives include Svix and cloud-native solutions like AWS EventBridge. webhooks.cc and Hookdeck are complementary tools: one built for development, one for production.",
  },
  {
    question: "What is the difference between webhooks.cc and Hookdeck?",
    answer:
      "Hookdeck is webhook infrastructure for production: it sits between webhook senders and your server, handling queuing, retries, rate limiting, routing, and delivery guarantees. webhooks.cc is a development and testing tool: it captures webhooks and email so you can inspect, replay, and assert on payloads during development and CI, and it can forward what it captures to up to 10 destinations with filters, throttling and retries. Hookdeck solves reliability in production. webhooks.cc solves visibility during development.",
  },
  {
    question: "Can I use webhooks.cc and Hookdeck together?",
    answer:
      "Yes. You can use webhooks.cc during development to capture and test webhook payloads, then use Hookdeck in production for reliable delivery and retry logic. They address different phases of the webhook lifecycle.",
  },
  {
    question: "Does Hookdeck have a free tier?",
    answer:
      "Yes. Hookdeck's Developer plan is free for one user, with 10,000 events a month and 3-day retention. webhooks.cc also offers a free tier with every Pro feature. Paid plans raise request limits and retention, Business adds more parsed pages, more layouts, custom inbound domains and file drops, and Teams (invite members, share endpoints) is billed separately from $12/seat/mo.",
  },
  {
    question: "Does webhooks.cc handle webhook retries and delivery guarantees?",
    answer:
      "Partly. Forwarding sends each captured request or email to up to 10 destinations per endpoint, each with its own filter, throttle, delay and format, retries a failed delivery for about a day, logs every try, and lets you redeliver what failed. The sender gets its answer from webhooks.cc (a mock response or a plain 200), not from your server, so it is not a gateway in front of production traffic. For production reliability at volume (queuing in front of your own service, delivery guarantees and alerting), Hookdeck or a similar infrastructure tool is the right choice.",
  },
  {
    question: "Is Hookdeck good for testing webhooks in development?",
    answer:
      "It works: hookdeck listen forwards webhooks to localhost and the Hookdeck dashboard keeps an event log. Hookdeck is built first as production infrastructure (retries, routing, rate limits), so testing is one part of a larger product. If development is all you need (an instant URL, replay, mock responses, and assertions in CI), webhooks.cc is built for exactly that, and the two can be used together.",
  },
  {
    question: "Hookdeck vs ngrok: which should I use for webhook forwarding?",
    answer:
      "ngrok is a general-purpose tunnel: it exposes any local port and shows traffic in a local inspector while the agent runs. Hookdeck receives webhooks on its own URL, logs them as events, and forwards them to localhost with hookdeck listen or to production with retries. For webhooks in development both work; webhooks.cc does the same with whk tunnel and adds stored history, replay to any URL, and SDK assertions.",
  },
  {
    question: "Hookdeck vs Webhook.site for testing webhooks?",
    answer:
      "Webhook.site gives you a URL and a page that shows every request, which suits quick inspection. Hookdeck is delivery infrastructure with a CLI for local forwarding. webhooks.cc sits between them for testing: an instant URL and live inspector like Webhook.site, plus a CLI tunnel, a TypeScript SDK for CI and an MCP server.",
  },
];

const ROWS = [
  ["Primary focus", "Webhook & email testing", "Webhook infrastructure & reliability"],
  ["Webhook capture & inspection", "Yes, core feature", "Yes, event log"],
  [
    "Retries",
    "Forwarded deliveries, for about a day",
    "Yes, with delivery guarantees (core feature)",
  ],
  ["Rate limiting & throttling", "Throttle per destination", "Yes"],
  ["Routing & fan-out", "Up to 10 destinations per endpoint, with filters", "Yes"],
  ["Failed deliveries", "Listed per endpoint, redeliver in bulk", "Issues and bulk retry"],
  ["Mock responses", "Yes, rule-based with placeholders", "No"],
  ["Request replay", "Yes, to any URL", "Yes, redelivery"],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "Yes (hookdeck listen)"],
  ["SDKs", "TypeScript, Python, Go, with test assertions", "Yes, infrastructure API"],
  ["CI test assertions (waitFor)", "Yes", "No"],
  [
    "Inbound email capture",
    "Yes, {slug}@mailhooks.cc or your own domain",
    "Through an email provider",
  ],
  [
    "MCP server for AI agents",
    "Yes, remote (OAuth) or local",
    "Yes, local, for Event Gateway operations",
  ],
  ["Open source", "Yes (AGPL + MIT)", "CLI and Outpost (Apache 2.0)"],
  ["Team collaboration", "From $12/seat/mo, pooled quota", "Team (from $39/mo), unlimited seats"],
  ["Free tier features", "Every Pro feature", "1 user, 10,000 events/month"],
] as const;

export const metadata = createPageMetadata({
  title: "Hookdeck Alternative: vs ngrok & Webhook.site (2026)",
  description:
    "Hookdeck alternative for webhook development and testing. Inspect, replay, forward and assert on webhooks and email with SDKs, a CLI tunnel, and an MCP server.",
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
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Hookdeck", path: "/compare/hookdeck" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Hookdeck</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Looking for a Hookdeck alternative for webhook development and testing? webhooks.cc
          captures webhooks and email, inspects payloads, replays requests, forwards them to the
          destinations you choose, and lets you write automated test assertions. Hookdeck handles
          production infrastructure: queuing, retries, rate limiting, routing, and delivery
          guarantees. They solve different problems and work well together.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <div className="ui-code overflow-x-auto mb-10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-strong border-line">
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
          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">
              Development testing vs production reliability
            </h3>
            <p className="text-muted-foreground">
              webhooks.cc captures every incoming webhook and makes it available for inspection,
              search, export, and replay. Its SDKs let you assert on payloads in CI test suites, and
              its forwarding sends what arrives to up to 10 destinations with filters, a throttle
              and retries, which suits staging, email to webhook and team alerts. Hookdeck sits in
              your production webhook delivery path: it receives webhooks, queues them, applies
              retries, rate limiting, and routing rules, then delivers them to your server. One is
              for building; the other is for running.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">AI agent integration</h3>
            <p className="text-muted-foreground">
              Both ship an MCP server, for different jobs. The webhooks.cc MCP server is for
              testing: AI coding agents like Claude Code, Cursor, and Codex create endpoints, send
              signed test payloads, inspect what arrived, and replay requests without opening the
              dashboard, through the remote server at webhooks.cc/mcp (one OAuth approval) or the
              local package. Hookdeck&apos;s MCP server (hookdeck gateway mcp, part of its CLI, read
              only unless you allow writes) is for operating its Event Gateway: agents read
              connections, events, delivery attempts, issues, and metrics to diagnose production
              traffic.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Complementary tools</h3>
            <p className="text-muted-foreground">
              These tools are not mutually exclusive. A common pattern: use webhooks.cc during
              development to capture and debug webhook payloads, write SDK assertions in your test
              suite, then use Hookdeck in production for reliable delivery with retries and rate
              limiting. For teams, webhooks.cc costs $12/seat/month ($35 for Team Business), while
              Hookdeck&apos;s Team plan starts at $39/month with unlimited seats.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Inspect and debug webhook payloads during development</li>
              <li>Write automated test assertions on webhook content</li>
              <li>Replay captured requests against your handler</li>
              <li>AI agent tooling for webhook workflows (MCP)</li>
              <li>Mock responses returned to webhook senders</li>
              <li>Inbound email captured, parsed and forwarded as JSON</li>
            </ul>
          </div>
          <div className="ui-card ui-card-static">
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
            href="/compare/requestbin"
            className="font-semibold hover:text-primary-ink transition-colors"
          >
            vs RequestBin
          </Link>
          {" · "}
          <Link
            href="/compare/webhook-site"
            className="font-semibold hover:text-primary-ink transition-colors"
          >
            vs Webhook.site
          </Link>
          {" · "}
          <Link
            href="/compare/ngrok"
            className="font-semibold hover:text-primary-ink transition-colors"
          >
            vs ngrok
          </Link>
          {" · "}
          <Link href="/compare" className="font-semibold hover:text-primary-ink transition-colors">
            All comparisons
          </Link>
        </p>

        {/* CTA */}
        <ComparisonCTA />
      </article>
    </main>
  );
}
