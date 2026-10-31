import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What is the difference between webhooks.cc and Svix?",
    answer:
      "Svix is webhook infrastructure: its core product dispatches outbound webhooks to your customers with retries and an embeddable App Portal, alongside Svix Ingest for managed incoming webhook queuing and Svix Play for basic browser inspection. webhooks.cc is a developer testing platform built for local development and CI/CD: it gives you endpoints that capture webhooks and inbound emails, generates signed test payloads for 32+ providers, forwards HTTP webhooks to localhost via whk tunnel, and provides a TypeScript SDK with waitFor() assertions and a 39-tool MCP server.",
  },
  {
    question: "webhooks.cc vs Svix Play and Svix Ingest: how do they compare for webhook testing?",
    answer:
      "Svix Play is Svix's free browser-based request bin for viewing incoming HTTP requests, while Svix Ingest is production ingestion infrastructure that receives third-party webhooks (such as Stripe or GitHub) and forwards them into your backend. webhooks.cc focuses on developer and CI testing: it combines an instant capture URL with CLI tunneling to localhost (whk tunnel), 32-provider signature generation and verification, inbound email capture (@mailhooks.cc), a TypeScript SDK with waitFor() matchers for Vitest/Jest/Playwright, and a 39-tool MCP server for AI coding agents.",
  },
  {
    question: "Can webhooks.cc verify Svix and Standard Webhooks signatures?",
    answer:
      "Yes. Both the webhooks.cc dashboard and @webhooks-cc/sdk verify Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature) and Svix headers (svix-id, svix-timestamp, svix-signature) used by providers like Clerk and Resend, alongside 30 other provider signing schemes including Stripe, GitHub, Shopify, Slack, Discord Ed25519, and PayPal RSA-SHA256.",
  },
  {
    question: "Can I use webhooks.cc and Svix together?",
    answer:
      "Yes. Teams that use Svix to send outbound webhooks to customers often point test destinations in Svix at a webhooks.cc endpoint so their CI suite can assert that outbound events are delivered, properly signed with svix-signature, and formatted as expected.",
  },
  {
    question: "How does pricing compare between webhooks.cc and Svix?",
    answer:
      "webhooks.cc has every Pro feature on its Free tier (50 requests/day), costs $8/month for Pro (100,000 requests/month) and $29/month for Business (250,000 requests/month, attachment parsing, custom inbound domains and file drops), and bills Teams at $12/seat/month with pooled quota. Svix offers open-source self-hosting and Svix Play for basic inspection, while hosted Svix Cloud plans start at $20/month (Basic) and $490/month (Professional) after the free developer tier.",
  },
];

const ROWS = [
  [
    "Primary focus",
    "Inbound webhook & email testing platform",
    "Outbound webhook delivery + Svix Ingest & Svix Play",
  ],
  [
    "Webhook capture & history",
    "Yes, searchable history + full headers/body",
    "Svix Play for basic bin; delivery logs in Svix Cloud / Ingest",
  ],
  [
    "Provider signature verification",
    "32 providers (Stripe, GitHub, Svix, Clerk, Discord, etc.)",
    "Standard Webhooks / Svix + major providers in Svix Ingest",
  ],
  [
    "Signed test payload templates",
    "34 providers (send signed events in 1 click or SDK)",
    "Standard Webhooks test events",
  ],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "Yes (svix listen for Play endpoints)"],
  ["Mock responses", "Yes, configurable status, headers & body", "Static response in Svix Play"],
  ["Request replay", "Yes, to any URL from dashboard, CLI, or SDK", "Resend delivery attempts"],
  ["CI test assertions (waitFor)", "Yes (@webhooks-cc/sdk matchers)", "No inbound assertion SDK"],
  ["Inbound email capture", "Yes ({slug}@mailhooks.cc + OTP extraction)", "No"],
  [
    "MCP server for AI agents",
    "Yes (@webhooks-cc/mcp, 39 testing tools)",
    "App Portal MCP (inspect deliveries & replay)",
  ],
  ["Outbound customer portal", "No", "Yes (core Svix feature)"],
  ["Open source", "Yes (AGPL + MIT)", "Yes (MIT server + libraries)"],
  ["Team collaboration", "$12/seat/mo, pooled quota", "Included on Svix Cloud tiers"],
] as const;

export const metadata = createPageMetadata({
  title: "Svix Alternative for Webhook Testing: vs Svix Play (2026)",
  description:
    "Compare webhooks.cc vs Svix, Svix Ingest, and Svix Play: webhook capture, 32-provider signature verification, CLI tunnel to localhost, CI SDK, and MCP.",
  path: "/compare/svix",
  keywords: [
    "svix alternative",
    "svix vs webhooks.cc",
    "svix play alternative",
    "svix ingest alternative",
    "svix webhook testing",
    "standard webhooks tester",
    "webhook testing tools",
  ],
});

export default function CompareSvixPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Svix", path: "/compare/svix" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">
          Comparison · Updated October 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Svix</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Svix is production webhook infrastructure: its core platform sends outbound webhooks to
          your customers, paired with Svix Ingest for receiving production webhooks and Svix Play as
          a free browser request bin. webhooks.cc is a developer testing platform built for
          capturing, verifying, replaying, and asserting on webhooks and inbound email across 32+
          providers in local development and CI/CD.
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
                  Svix / Svix Ingest / Svix Play
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
              Developer testing platform vs production webhook infrastructure
            </h3>
            <p className="text-muted-foreground">
              Svix is built first for production webhook delivery: dispatching your product&apos;s
              outbound webhooks to customer endpoints (with an embeddable App Portal) and ingesting
              production events via Svix Ingest. webhooks.cc is built specifically for local
              development, staging, and CI testing: it generates properly signed test payloads and
              verifies signatures for 32 providers out of the box (including Svix&apos;s own{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">svix-signature</code> and{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">webhook-signature</code>{" "}
              headers).
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">CI/CD assertions vs manual browser bins</h3>
            <p className="text-muted-foreground">
              Svix Play gives you a browser bin for quick manual checks, similar to RequestBin.
              webhooks.cc adds{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">@webhooks-cc/sdk</code>{" "}
              with <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">withEndpoint()</code>
              , <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">waitFor()</code>, and{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">sendTo()</code> so your
              Vitest, Jest, or Playwright suite can verify webhook handlers deterministically in CI
              without running a tunnel.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">AI agent MCP server and email capture</h3>
            <p className="text-muted-foreground">
              Every webhooks.cc endpoint also receives email at{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">
                {"{slug}"}@mailhooks.cc
              </code>{" "}
              with automatic OTP and magic-link extraction, and the{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">@webhooks-cc/mcp</code>{" "}
              server exposes 39 testing tools to Claude Code, Cursor, and Codex (creating endpoints,
              sending signed provider templates, waiting for deliveries, and replaying to
              localhost). Svix offers an App Portal MCP focused on inspecting and replaying messages
              on existing Svix endpoints, and does not capture inbound email.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Capture, inspect, and replay inbound webhooks from 32+ providers</li>
              <li>Send signed Stripe, GitHub, Shopify, Clerk, or Svix test templates</li>
              <li>Automated webhook and signup-email assertions in CI tests</li>
              <li>CLI localhost forwarding (whk tunnel) with stored history</li>
              <li>MCP tools for AI coding agents (Claude Code, Cursor, Codex)</li>
            </ul>
          </div>
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose Svix when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>An outbound webhook delivery service for your own SaaS product</li>
              <li>An embeddable portal where your customers manage their endpoints</li>
              <li>Managed production webhook queuing and retries (Svix Outbound / Ingest)</li>
              <li>A quick unauthenticated browser bin (Svix Play) with no test SDK needed</li>
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
