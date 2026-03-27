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
    question: "Can I replace ngrok with webhooks.cc?",
    answer:
      "For webhook testing, yes. webhooks.cc captures incoming webhooks, stores request history, and forwards to localhost via the CLI tunnel. If you use ngrok only to receive webhooks during development, webhooks.cc covers that workflow and adds inspection, replay, SDK assertions, and MCP support. If you use ngrok for general-purpose tunneling (exposing web apps, TCP services, databases), ngrok remains the better fit — webhooks.cc is purpose-built for webhooks.",
  },
  {
    question: "How does the webhooks.cc CLI tunnel compare to ngrok's tunnel?",
    answer:
      "Both forward traffic to a local port. The difference is scope: ngrok exposes any local service over a public URL. The webhooks.cc CLI (whk tunnel) captures every incoming request in the dashboard with full headers, body, and metadata — then forwards it to localhost. You get inspection + tunnel in one step. ngrok requires a separate tool or custom code to log and inspect payloads.",
  },
  {
    question: "Is webhooks.cc free?",
    answer:
      "Yes. webhooks.cc has a free tier that includes all features — webhook capture, inspection, replay, mock responses, CLI tunnel, TypeScript SDK, and MCP server. The paid plan increases rate limits and retention. ngrok also has a free tier, but some features (like custom domains and IP restrictions) require paid plans.",
  },
  {
    question: "Does ngrok have a webhook testing SDK?",
    answer:
      "ngrok provides client libraries for embedding tunnels into applications, but no SDK designed for webhook test assertions. webhooks.cc's TypeScript SDK includes waitFor() with request matchers (method, headers, body path) for use in Vitest or Jest integration tests.",
  },
];

const ROWS = [
  ["Primary purpose", "Webhook testing platform", "General-purpose tunneling"],
  ["Webhook capture & history", "Yes — stored with full detail", "No built-in history"],
  ["Request inspection", "Dashboard + CLI + SDK + MCP", "ngrok dashboard (paid)"],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "Yes (ngrok http)"],
  ["Mock responses", "Yes — configurable per endpoint", "No"],
  ["Request replay", "Yes", "No"],
  ["TypeScript SDK", "Yes — @webhooks-cc/sdk", "No webhook-testing SDK"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  ["MCP server for AI agents", "Yes — @webhooks-cc/mcp", "No"],
  ["TCP / non-HTTP tunneling", "No (HTTP webhooks only)", "Yes"],
  ["Custom domains", "No", "Yes (paid)"],
  ["Edge computing / traffic policy", "No", "Yes (paid)"],
  ["Open source", "Yes (AGPL + MIT)", "Partially (agent)"],
  ["Free tier", "All features, rate-limited", "Limited connections + features"],
] as const;

export const metadata = createPageMetadata({
  title: "ngrok Alternative for Webhook Testing (2026)",
  description:
    "Need an ngrok alternative for webhook testing? webhooks.cc captures, inspects, and replays webhooks with SDK assertions and an MCP server for AI agents. Free tier, all features included.",
  path: "/compare/ngrok",
  keywords: [
    "ngrok alternative",
    "ngrok alternatives",
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
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs ngrok", path: "/compare/ngrok" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison · Updated March 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs ngrok</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you use ngrok mainly for webhook development, webhooks.cc is a purpose-built alternative
          that captures, inspects, replays, and forwards webhooks to localhost — with a TypeScript SDK,
          CLI tunnel, and MCP server included. ngrok is a general-purpose tunnel for exposing any
          local service to the internet. Different tools, different focus.
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
          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Webhook history and inspection</h3>
            <p className="text-muted-foreground">
              ngrok tunnels traffic to your local server, but does not store or index incoming
              requests. To inspect a webhook payload, you need to add logging to your own code or use
              ngrok&apos;s paid inspection dashboard. webhooks.cc captures every request automatically —
              headers, body, query params, IP, timing — and makes it searchable, exportable, and
              replayable from the dashboard, CLI, or SDK.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Testing and CI integration</h3>
            <p className="text-muted-foreground">
              webhooks.cc provides a TypeScript SDK with{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5">waitFor()</code> — create an endpoint,
              trigger your integration, and assert on the captured webhook in your test suite. This
              works in CI without opening any tunnels. ngrok is designed for runtime tunneling, not
              test-time assertions.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Scope and complexity</h3>
            <p className="text-muted-foreground">
              ngrok supports TCP tunnels, custom domains, traffic policies, IP restrictions, and edge
              computing — features that go well beyond webhooks. If you need those, ngrok is the right
              tool. If your goal is to test and debug webhook integrations, webhooks.cc does that with
              less setup and more webhook-specific tooling.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Full webhook request history with search and replay</li>
              <li>SDK assertions for webhook payloads in CI tests</li>
              <li>MCP integration for AI-assisted webhook workflows</li>
              <li>Mock responses returned to the webhook sender</li>
              <li>A tunnel that captures and inspects, not just forwards</li>
            </ul>
          </div>
          <div className="neo-card neo-card-static">
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
