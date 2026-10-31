import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best ngrok alternatives for webhook testing in 2026?",
    answer:
      "webhooks.cc is a strong ngrok alternative if your primary use case is webhook testing. It captures, inspects, and replays webhooks with a TypeScript SDK for CI assertions and an MCP server for AI agents. Other alternatives include LocalTunnel (free open-source tunnel), Smee.io (GitHub's webhook proxy), and Hookdeck (production webhook infrastructure).",
  },
  {
    question: "ngrok vs Hookdeck: which is better for webhook testing?",
    answer:
      "ngrok is a general-purpose tunnel that exposes local ports over HTTP/TCP and inspects traffic only while the agent runs. Hookdeck is production webhook infrastructure with an event gateway, retries, and hookdeck listen for local forwarding. If your goal is testing webhooks in development and CI, webhooks.cc combines both strengths: a permanent capture URL, whk tunnel to localhost, 32-provider signature verification, a TypeScript SDK for CI assertions, and an MCP server.",
  },
  {
    question: "Can I replace ngrok with webhooks.cc?",
    answer:
      "For webhook testing, yes. webhooks.cc captures incoming webhooks, stores request history, and forwards to localhost via the CLI tunnel. If you use ngrok only to receive webhooks during development, webhooks.cc covers that workflow and adds inspection, replay, SDK assertions, and MCP support. If you use ngrok for general-purpose tunneling (exposing web apps, TCP services, databases), ngrok remains the better fit because webhooks.cc is purpose-built for webhooks.",
  },
  {
    question: "How does the webhooks.cc CLI tunnel compare to ngrok's tunnel?",
    answer:
      "Both forward traffic to a local port. The difference is scope: ngrok exposes any local service over a public URL. The webhooks.cc CLI (whk tunnel) captures every incoming request in the dashboard with full headers, body, and metadata, then forwards it to localhost. You get inspection + tunnel in one step. ngrok's local inspector shows requests while the agent runs, but keeps no searchable history you can query from tests or replay to another URL.",
  },
  {
    question: "Is webhooks.cc free?",
    answer:
      "Yes. The free plan has every Pro feature: webhook capture, inspection, replay, mock responses, CLI tunnel, TypeScript SDK, and MCP server. Paid plans raise rate limits and retention, Business adds attachment parsing, more layouts, custom inbound domains and file drops, and Teams (invite members, share endpoints) is billed separately at $12/seat/mo. ngrok also has a free tier, but some features (like custom domains and IP restrictions) require paid plans.",
  },
  {
    question: "Does ngrok have a webhook testing SDK?",
    answer:
      "ngrok provides client libraries for embedding tunnels into applications, but no SDK designed for webhook test assertions. webhooks.cc's TypeScript SDK includes waitFor() with request matchers (method, headers, body path) for use in Vitest or Jest integration tests.",
  },
  {
    question: "ngrok vs Webhook.site for receiving webhooks on localhost?",
    answer:
      "ngrok forwards traffic to your local port and shows it in a local inspector at localhost:4040 while the agent runs. Webhook.site captures requests on a hosted URL and shows them in the browser; forwarding to localhost needs its CLI. webhooks.cc does both in one step: whk tunnel captures every webhook in a stored, searchable history and forwards it to localhost.",
  },
  {
    question: "ngrok vs LocalTunnel: what is the difference?",
    answer:
      "Both expose a local port on a public URL. ngrok is a commercial service with a free tier, stable domains on paid plans, TCP tunnels and a local request inspector. LocalTunnel is free and open source, with a random URL per session and no inspector. For webhooks, webhooks.cc adds a stored, searchable history, replay to any URL and SDK assertions, and forwards to localhost too.",
  },
];

const ROWS = [
  ["Primary purpose", "Webhook testing platform", "General-purpose tunneling"],
  [
    "Webhook capture & history",
    "Yes, stored with full detail",
    "Local inspector while the agent runs",
  ],
  [
    "Request inspection",
    "Dashboard + CLI + SDK + MCP",
    "Local inspector (localhost:4040), dashboard Traffic Inspector",
  ],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "Yes (ngrok http)"],
  ["Mock responses", "Yes, configurable per endpoint", "No"],
  ["Request replay", "Yes, to any URL", "Yes, to the local upstream"],
  ["TypeScript SDK", "Yes (@webhooks-cc/sdk)", "No webhook-testing SDK"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  ["MCP server for AI agents", "Yes (@webhooks-cc/mcp)", "No"],
  ["TCP / non-HTTP tunneling", "No (HTTP webhooks only)", "Yes"],
  ["Custom domains", "No", "Yes (paid)"],
  ["Edge computing / traffic policy", "No", "Yes (paid)"],
  ["Open source", "Yes (AGPL + MIT)", "Partially (agent)"],
  ["Team collaboration", "$12/seat/mo, pooled quota", "$20/mo incl. 3 seats, then $5/seat"],
  ["Free tier features", "Every Pro feature", "Limited connections + features"],
] as const;

export const metadata = createPageMetadata({
  title: "ngrok Alternative: vs Hookdeck & Webhook.site (2026)",
  description:
    "Compare ngrok vs webhooks.cc, Hookdeck, and Webhook.site for webhook testing: stored request history, CLI tunnel to localhost, replay, CI SDK, and MCP server.",
  path: "/compare/ngrok",
  keywords: [
    "ngrok alternative",
    "ngrok alternatives",
    "ngrok vs hookdeck",
    "best ngrok alternative",
    "ngrok alternative for webhooks",
    "ngrok webhook testing",
    "webhooks.cc vs ngrok",
    "ngrok free alternative",
    "webhook tunnel alternative",
    "localhost webhook testing",
  ],
});

export default function CompareNgrokPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs ngrok", path: "/compare/ngrok" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">
          Comparison · Updated October 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs ngrok</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you use ngrok mainly for webhook development, webhooks.cc is a purpose-built
          alternative that captures, inspects, replays, and forwards webhooks to localhost with a
          TypeScript SDK, CLI tunnel, and MCP server included. ngrok is a general-purpose tunnel for
          exposing any local service to the internet. Different tools, different focus.
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
                  ngrok
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
            <h3 className="text-lg font-bold mb-2">Webhook history and inspection</h3>
            <p className="text-muted-foreground">
              ngrok tunnels traffic to your local server and shows it in a local inspector at
              localhost:4040 while the agent runs, with replay to the same upstream; its dashboard
              Traffic Inspector keeps traffic for longer. webhooks.cc captures every request
              automatically (headers, body, query params, IP, timing) and makes it searchable,
              exportable, and replayable from the dashboard, CLI, or SDK.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Testing and CI integration</h3>
            <p className="text-muted-foreground">
              webhooks.cc provides a TypeScript SDK with{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">waitFor()</code>: create
              an endpoint, trigger your integration, and assert on the captured webhook in your test
              suite. This works in CI without opening any tunnels. ngrok is designed for runtime
              tunneling, not test-time assertions.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Scope and complexity</h3>
            <p className="text-muted-foreground">
              ngrok supports TCP tunnels, custom domains, traffic policies, IP restrictions, and
              edge computing, which go well beyond webhooks. If you need those, ngrok is the right
              tool. If your goal is to test and debug webhook integrations, webhooks.cc does that
              with less setup and more webhook-specific tooling. Team collaboration on webhooks.cc
              costs $12/seat/month, while ngrok&apos;s pay-as-you-go plan starts at $20/month with 3
              seats included and $5 per additional seat, plus metered usage.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Full webhook request history with search and replay</li>
              <li>SDK assertions for webhook payloads in CI tests</li>
              <li>MCP integration for AI-assisted webhook workflows</li>
              <li>Mock responses returned to the webhook sender</li>
              <li>A tunnel that captures and inspects, not just forwards</li>
            </ul>
          </div>
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose ngrok when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>General-purpose tunneling for any protocol (HTTP, TCP, TLS)</li>
              <li>Custom domains and static URLs for staging environments</li>
              <li>Traffic policies, IP restrictions, or edge compute</li>
              <li>Broad infrastructure tunneling beyond webhook testing</li>
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
            href="/compare/localtunnel"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs LocalTunnel
          </Link>
          {" · "}
          <Link
            href="/compare/hookdeck"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Hookdeck
          </Link>
          {" · "}
          <Link
            href="/compare/stripe-cli"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Stripe CLI
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
