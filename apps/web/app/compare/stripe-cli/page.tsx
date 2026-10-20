import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question:
      "Are there any webhook tools with a CLI that forwards to localhost like the Stripe CLI does?",
    answer:
      "Yes. The webhooks.cc CLI (whk tunnel <port>) works like stripe listen --forward-to, but for any HTTP webhook provider. Every HTTP request sent to https://go.webhooks.cc/w/{slug} is captured in a searchable history, verified, and forwarded to your local server. For inbound emails sent to {slug}@mailhooks.cc, you can configure endpoint forwarding to post each captured email as signed JSON to your server or test locally with the SDK and dashboard.",
  },
  {
    question: "Can webhooks.cc replace stripe listen for testing Stripe webhooks?",
    answer:
      "You can use either or both. stripe listen streams events directly from your Stripe account over WebSockets. webhooks.cc gives you a permanent HTTPS URL you can register in Stripe test mode (so deliveries are stored even when your laptop is closed), sends signed Stripe templates (checkout.session.completed, invoice.paid, customer.subscription.updated) via the SDK or dashboard without needing the Stripe CLI installed in CI, and forwards live deliveries to localhost with whk tunnel.",
  },
  {
    question: "How do I test Stripe webhooks in CI/CD without running stripe listen?",
    answer:
      "Use sendTo() from @webhooks-cc/sdk in your Vitest, Jest, or Playwright test. Call client.sendTo('http://localhost:3000/api/webhooks/stripe', { provider: 'stripe', template: 'checkout.session.completed', secret: process.env.STRIPE_WEBHOOK_SECRET }). The SDK generates a valid t=timestamp,v1=hash stripe-signature header that passes stripe.webhooks.constructEvent() with no background CLI process required.",
  },
  {
    question: "What providers does webhooks.cc support besides Stripe?",
    answer:
      "webhooks.cc captures webhooks from any HTTP sender and includes built-in signature verification and signed payload templates for 32+ providers, including GitHub, Shopify, Clerk, Resend, Linear, Slack, Twilio, Discord, Paddle, Lemon Squeezy, Coinbase Commerce, Square, DocuSign, Adyen, and PayPal.",
  },
  {
    question: "Does the Stripe CLI store webhook history or support team sharing?",
    answer:
      "Stripe logs webhook events in the Stripe Dashboard for your Stripe account, while stripe listen prints events to your local terminal session. webhooks.cc provides a unified, searchable inbox across all your webhook and email providers, with one-click replay to any URL and shared team endpoints ($12/seat/mo).",
  },
];

const ROWS = [
  [
    "Supported providers",
    "All HTTP webhooks + 32 signed providers (Stripe, GitHub, Shopify, Clerk, etc.)",
    "Stripe only",
  ],
  [
    "Localhost CLI forwarding",
    "Yes (whk tunnel 3000 for HTTP webhooks)",
    "Yes (stripe listen --forward-to localhost:3000)",
  ],
  [
    "Inbound email capture & forwarding",
    "Yes ({slug}@mailhooks.cc + HTTP forwarding as signed JSON)",
    "No",
  ],
  [
    "Captures when CLI is offline",
    "Yes (hosted endpoint stores every delivery)",
    "Only in Stripe Dashboard Event logs",
  ],
  [
    "Signed test events in CI without CLI daemon",
    "Yes (client.sendTo() with valid stripe-signature)",
    "Requires stripe trigger + running stripe listen",
  ],
  [
    "Cross-provider request search & diff",
    "Yes (full-text search + side-by-side payload diff)",
    "No",
  ],
  [
    "Replay to any URL",
    "Yes (dashboard, CLI, SDK, or MCP)",
    "stripe events resend (to Stripe URL)",
  ],
  ["Mock custom status codes & bodies", "Yes (configurable per endpoint)", "No"],
  ["MCP server for AI coding agents", "Yes (@webhooks-cc/mcp, 38 tools)", "Stripe MCP (API ops)"],
  ["Open source", "Yes (AGPL + MIT)", "Yes (Apache 2.0 CLI)"],
] as const;

export const metadata = createPageMetadata({
  title: "Stripe CLI Alternative: Multi-Provider Webhook & Email CLI",
  description:
    "Compare webhooks.cc (whk CLI) vs Stripe CLI (stripe listen): forward webhooks to localhost across 32+ providers, capture inbound emails, and test in CI with SDK.",
  path: "/compare/stripe-cli",
  keywords: [
    "stripe cli webhook test",
    "stripe listen alternative",
    "stripe cli alternative",
    "forward webhooks to localhost cli",
    "email webhook cli localhost",
    "test stripe webhooks in ci",
    "webhooks.cc vs stripe cli",
  ],
});

export default function CompareStripeCliPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Stripe CLI", path: "/compare/stripe-cli" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">
          Comparison · Updated October 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Stripe CLI</h1>
        <p className="text-lg text-muted-foreground mb-10">
          The Stripe CLI (
          <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">stripe listen</code> and{" "}
          <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">stripe trigger</code>) set the
          standard for local Stripe webhook testing. webhooks.cc brings that same workflow to every
          webhook and email provider in your stack: a fast Go CLI tunnel (
          <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">whk tunnel</code>), a hosted
          request and email inbox that captures deliveries even when your terminal is closed, and a
          TypeScript SDK that sends genuine{" "}
          <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">stripe-signature</code>{" "}
          payloads in CI without a background daemon.
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
                  webhooks.cc (whk CLI + SDK)
                </th>
                <th scope="col" className="text-left py-2.5 font-bold">
                  Stripe CLI (stripe listen)
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
              One platform for Stripe, GitHub, Clerk, Shopify, and inbound email
            </h3>
            <p className="text-muted-foreground">
              Modern apps rarely receive webhooks from Stripe alone; they also handle Clerk or
              WorkOS auth hooks, GitHub or Vercel deploy hooks, and Resend or Postmark email events.
              Instead of juggling separate tunnels and provider CLIs,{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">whk tunnel 3000</code>{" "}
              forwards any provider&apos;s HTTP webhooks to your local server with automatic
              signature verification, while inbound emails sent to{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">
                {"{slug}"}@mailhooks.cc
              </code>{" "}
              are captured with OTP extraction and can be forwarded to your server as signed JSON or
              asserted in tests via the SDK.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">
              Deterministic CI tests without a background CLI daemon
            </h3>
            <p className="text-muted-foreground">
              Running{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">stripe listen</code>{" "}
              inside GitHub Actions requires Stripe API keys, a background WebSocket process, and
              network round-trips. With{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">@webhooks-cc/sdk</code>,
              your Vitest or Playwright test calls{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">
                {
                  "client.sendTo(url, { provider: 'stripe', template: 'checkout.session.completed', secret })"
                }
              </code>{" "}
              to post a payload signed with the exact{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">t=...,v1=...</code>{" "}
              HMAC-SHA256 format that{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">
                stripe.webhooks.constructEvent()
              </code>{" "}
              expects.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">
              Persistent capture when your laptop is closed
            </h3>
            <p className="text-muted-foreground">
              When you stop{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">stripe listen</code>,
              local forwarding stops. A webhooks.cc endpoint URL stays live 24/7 for your staging or
              sandbox environment, captures every delivery with headers and timing, and lets any
              teammate inspect or replay a payload to their own{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">localhost</code> with one
              click.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A Stripe-CLI-style workflow across 32+ webhook providers and email</li>
              <li>Signed Stripe, GitHub, Shopify, and Clerk payloads in CI without a tunnel</li>
              <li>A permanent URL that captures webhooks while your terminal is closed</li>
              <li>Shared staging endpoints for your team ($12/seat/mo)</li>
              <li>MCP tools so Claude Code or Cursor can trigger and inspect webhooks</li>
            </ul>
          </div>
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose Stripe CLI when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Direct WebSocket streaming from your Stripe account with zero URL setup</li>
              <li>Triggering real test-mode objects inside Stripe&apos;s API via stripe trigger</li>
              <li>Stripe-only local development where no other webhook providers are used</li>
              <li>Managing Stripe resources and logs from the terminal</li>
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
            href="/webhooks/stripe"
            className="font-semibold hover:text-primary transition-colors"
          >
            Stripe Webhook Tester
          </Link>
          {" · "}
          <Link
            href="/compare/ngrok"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs ngrok
          </Link>
          {" · "}
          <Link
            href="/compare/hookdeck"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Hookdeck
          </Link>
          {" · "}
          <Link href="/compare/svix" className="font-semibold hover:text-primary transition-colors">
            vs Svix
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
