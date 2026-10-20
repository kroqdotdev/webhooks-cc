import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What is the difference between webhooks.cc and Svix?",
    answer:
      "Svix is outbound webhook delivery infrastructure: you call the Svix API from your backend to send webhooks to your customers, and Svix handles retries, fan-out, and an embeddable customer portal. webhooks.cc is an inbound webhook and email testing platform: it gives you endpoints that capture webhooks from Stripe, GitHub, Shopify, Clerk, Svix, and 50+ other providers, verifies their signatures, forwards deliveries to localhost, and lets you assert on payloads in CI with a TypeScript SDK or MCP server.",
  },
  {
    question: "webhooks.cc vs Svix Play: how do they compare for webhook testing?",
    answer:
      "Svix Play is Svix's free browser-based request bin for viewing incoming HTTP requests. webhooks.cc also gives you an instant capture URL, and adds CLI tunneling to localhost (whk tunnel), 32-provider signature generation and verification, inbound email capture (@mailhooks.cc), a TypeScript SDK with waitFor() matchers for Vitest/Jest/Playwright, and a 38-tool MCP server for AI coding agents.",
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
      "webhooks.cc includes every individual feature on its Free tier (50 requests/day), costs $8/month for Pro (100,000 requests/month), and bills Teams at $12/seat/month with pooled quota. Svix offers open-source self-hosting and Svix Play for basic inspection, while hosted Svix Cloud plans for outbound webhook delivery start at $490/month after the free developer tier.",
  },
];

const ROWS = [
  [
    "Primary focus",
    "Inbound webhook & email testing platform",
    "Outbound webhook delivery service (+ Svix Play inspector)",
  ],
  [
    "Webhook capture & history",
    "Yes, searchable history + full headers/body",
    "Svix Play for basic bin; outbound logs in Svix Cloud",
  ],
  [
    "Provider signature verification",
    "32 providers (Stripe, GitHub, Svix, Clerk, Discord, etc.)",
    "Standard Webhooks / Svix signatures only",
  ],
  [
    "Signed test payload templates",
    "34 providers (send signed events in 1 click or SDK)",
    "Standard Webhooks test events",
  ],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "Yes (svix listen for Play endpoints)"],
  ["Mock responses", "Yes, configurable status, headers & body", "Static response in Svix Play"],
  ["Request replay", "Yes, to any URL from dashboard, CLI, or SDK", "Resend outbound attempts"],
  ["CI test assertions (waitFor)", "Yes (@webhooks-cc/sdk matchers)", "No inbound assertion SDK"],
  ["Inbound email capture", "Yes ({slug}@mailhooks.cc + OTP extraction)", "No"],
  ["MCP server for AI agents", "Yes (@webhooks-cc/mcp, 38 tools)", "No"],
  ["Outbound customer portal", "No", "Yes (core Svix feature)"],
  ["Open source", "Yes (AGPL + MIT)", "Yes (MIT server + libraries)"],
  ["Team collaboration", "$12/seat/mo, pooled quota", "Included on Svix Cloud tiers"],
] as const;

export const metadata = createPageMetadata({
  title: "Svix Alternative for Webhook Testing: vs Svix Play (2026)",
  description:
    "Compare webhooks.cc vs Svix and Svix Play: inbound webhook capture, 32-provider signature verification, CLI tunnel to localhost, TypeScript CI SDK, and MCP.",
  path: "/compare/svix",
  keywords: [
    "svix alternative",
    "svix vs webhooks.cc",
    "svix play alternative",
    "svix webhook testing",
    "standard webhooks tester",
    "webhook testing tools",
  ],
});

export default function CompareSvixPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
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
          Svix and webhooks.cc sit on opposite sides of the webhook lifecycle. Svix is outbound
          infrastructure for companies sending webhooks to their customers (plus Svix Play, a free
          request bin). webhooks.cc is an inbound webhook and email testing platform built for
          capturing, verifying, replaying, and asserting on webhooks from 32+ providers in local
          development and CI/CD.
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
                  Svix / Svix Play
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
              Inbound multi-provider testing vs outbound webhook dispatcher
            </h3>
            <p className="text-muted-foreground">
              Most developers searching for a webhook tool are integrating incoming webhooks from
              Stripe, GitHub, Shopify, Clerk, Resend, Linear, or Slack. webhooks.cc generates
              properly signed test payloads and verifies signatures for 32 providers out of the box
              (including Svix&apos;s own{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">svix-signature</code> and{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">webhook-signature</code>{" "}
              headers). Svix is built for the opposite job: dispatching your own product&apos;s
              outbound webhooks to customer endpoints.
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
              server exposes 38 tools to Claude Code, Cursor, and Codex. Svix does not capture
              inbound email or ship a testing MCP server.
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
              <li>Managed outbound retry schedules, fan-out, and Standard Webhooks signing</li>
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
