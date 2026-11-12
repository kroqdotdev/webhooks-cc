import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { ComparisonCTA } from "@/components/compare/comparison-cta";
import { InlineCode } from "@/components/ui/code";
import { Card } from "@/components/ui/card";
import { PairLinks } from "@/components/compare/pair-links";

const FAQ_ITEMS = [
  {
    question: "What are the best ngrok alternatives for webhook testing in 2026?",
    answer:
      "webhooks.cc is a strong ngrok alternative if you use ngrok for webhooks or to show a local site. It captures, inspects, and replays webhooks and email, forwards them to localhost, shares a local site at a public link, and has SDKs for CI assertions in TypeScript, Python and Go and an MCP server for AI agents. Other alternatives include Cloudflare Tunnel (tunnels to your own domain), Pinggy (tunnels over SSH), LocalTunnel (free open-source tunnel), Smee.io (GitHub's webhook proxy), and Hookdeck (production webhook infrastructure).",
  },
  {
    question: "Can I replace ngrok with webhooks.cc?",
    answer:
      "For webhook testing and for showing a local site, yes. webhooks.cc captures incoming webhooks, stores request history, and forwards to localhost via the CLI tunnel; whk tunnel --live answers senders with your local app's response, and whk share puts a local web app at a public link on sharehooks.cc. If you use ngrok for TCP services, databases, your own domains or production traffic, ngrok remains the better fit.",
  },
  {
    question: "How does the webhooks.cc CLI tunnel compare to ngrok's tunnel?",
    answer:
      "Both forward traffic to a local port. The difference is scope: ngrok exposes any local service over a public URL. The webhooks.cc CLI (whk tunnel) captures every incoming request in the dashboard with full headers, body, and metadata, then forwards it to localhost. You get inspection + tunnel in one step. ngrok's local inspector shows requests while the agent runs, but keeps no searchable history you can query from tests or replay to another URL.",
  },
  {
    question: "Can webhooks.cc share a local site like ngrok http?",
    answer:
      "Yes. whk share 3000 puts your local site at an HTTPS link on sharehooks.cc, with WebSockets and live reload passing through. Free shares get a random name ending in -free, last 2 hours and include 1 GB a month; Pro ($8/month) keeps 3 reserved names, adds passwords and 25 GB a month. ngrok's free plan gives one assigned ngrok-free.app domain that stays the same across restarts, with 1 GB and 20,000 HTTP requests a month; its Hobbyist plan ($10/month) removes the interstitial page.",
  },
  {
    question: "Is webhooks.cc free?",
    answer:
      "Yes. The free plan has every Pro feature: webhook and email capture, inspection, replay, mock responses, forwarding, CLI tunnel, SDKs, and MCP server, and it can share a local site within smaller limits. Paid plans raise request limits and retention, Business adds more parsed pages, more layouts, custom inbound domains and file drops, and Teams (invite members, share endpoints) is billed separately from $12/seat/mo. ngrok also has a free tier, but some features (like custom domains and IP restrictions) require paid plans.",
  },
  {
    question: "Does ngrok have a webhook testing SDK?",
    answer:
      "ngrok provides client libraries for embedding tunnels into applications, but no SDK designed for webhook test assertions. webhooks.cc's TypeScript SDK includes waitFor() with request matchers (method, headers, body path) for use in Vitest or Jest integration tests, and its Python and Go SDKs do the same in pytest and go test.",
  },
  {
    question: "What does webhooks.cc not do that ngrok does?",
    answer:
      "TCP and TLS tunnels, your own domain on a tunnel, and traffic policies. whk share also serves web pages only, up to 50 MB a response, with no downloads or video. ngrok's free domain stays the same across restarts, while a Free share gets a new random name each time; reserved names start on Pro.",
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
  ["Share a local site at a public link", "Yes (whk share, on sharehooks.cc)", "Yes (ngrok http)"],
  [
    "Webhook sender gets your local app's answer",
    "Yes, with whk tunnel --live, and the request is kept",
    "Yes, the tunnel proxies the response",
  ],
  [
    "Free plan link",
    "A random -free name per session, 2-hour sessions",
    "One assigned ngrok-free.app domain, kept across restarts",
  ],
  [
    "Free plan allowance",
    "1 GB shared data a month, plus 50 captured webhooks a day",
    "1 GB data and 20,000 HTTP requests a month",
  ],
  ["Browser warning page on free", "Yes, once a week per browser", "Yes, once a week per browser"],
  [
    "Stable names, paid",
    "Pro ($8/mo): 3 reserved names, 25 GB a month",
    "Hobbyist ($10/mo): ngrok-branded domains, 5 GB included",
  ],
  [
    "Password on a shared link",
    "Pro and up (whk share --password)",
    "Basic auth, OAuth and more through Traffic Policy",
  ],
  ["Mock responses", "Yes, configurable per endpoint", "No"],
  ["Request replay", "Yes, to any URL", "Yes, to the local upstream"],
  ["SDKs", "TypeScript, Python and Go, for testing", "No webhook-testing SDK"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  [
    "MCP server for AI agents",
    "Yes, for testing: remote (OAuth) or local",
    "Yes, for account and traffic operations",
  ],
  ["TCP / non-HTTP tunneling", "No TCP tunnels; captures email too", "Yes"],
  ["Custom domains", "For inbound email, on Business", "Yes (Pay-as-you-go)"],
  ["Edge computing / traffic policy", "Response rules for mock answers", "Yes (paid)"],
  ["Open source", "Yes (AGPL + MIT)", "Partially (agent SDKs)"],
  ["Team collaboration", "From $12/seat/mo, pooled quota", "$20/mo incl. 3 seats, then $5/seat"],
  [
    "Free tier features",
    "Every webhook feature; share names and passwords need Pro",
    "Limited connections + features",
  ],
] as const;

export const metadata = createPageMetadata({
  title: "ngrok Alternative for Webhooks and Sharing Localhost (2026)",
  description:
    "An ngrok alternative for webhook testing and sharing localhost: stored request history, a CLI tunnel, live replies, public share links, SDKs for CI and an MCP server.",
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
    "share localhost",
    "ngrok free plan limits",
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
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs ngrok</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you use ngrok mainly for webhook development, webhooks.cc is a purpose-built
          alternative that captures, inspects, replays, and forwards webhooks to localhost, with
          SDKs for TypeScript, Python and Go, a CLI tunnel, and an MCP server included. Its CLI also
          lets you{" "}
          <Link href="/share" className="text-primary font-bold hover:underline">
            share localhost
          </Link>{" "}
          at a public link (<code>whk share</code>) and lets webhook senders get your local
          app&apos;s answer (<code>whk tunnel --live</code>). ngrok is a general-purpose tunnel for
          exposing any local service to the internet, with TCP, your own domains and traffic
          policies. Different tools, different focus.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <ComparisonTable
          tools={[{ name: "webhooks.cc", ours: true }, { name: "ngrok" }]}
          rows={ROWS}
          className="mb-10"
        />

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <Card>
            <h3 className="text-lg font-bold mb-2">Webhook history and inspection</h3>
            <p className="text-muted-foreground">
              ngrok tunnels traffic to your local server and shows it in a local inspector at
              localhost:4040 while the agent runs, with replay to the same upstream; its dashboard
              Traffic Inspector keeps traffic for 24 hours on the free plan and 72 hours on paid
              plans. webhooks.cc captures every request automatically (headers, body, query params,
              IP, timing) and makes it searchable, exportable, and replayable from the dashboard,
              CLI, or SDK.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Testing and CI integration</h3>
            <p className="text-muted-foreground">
              webhooks.cc provides SDKs for TypeScript, Python and Go with{" "}
              <InlineCode>waitFor()</InlineCode>: create an endpoint, trigger your integration, and
              assert on the captured webhook in your test suite. This works in CI without opening
              any tunnels. ngrok is designed for runtime tunneling, not test-time assertions; its
              MCP server manages endpoints, traffic and policies rather than tests.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Sharing a local site</h3>
            <p className="text-muted-foreground">
              Both put a local web app at a public HTTPS link. ngrok&apos;s free plan gives one
              assigned ngrok-free.app domain that stays the same across restarts, shows an
              interstitial page to browsers, and includes 1 GB of data and 20,000 HTTP requests a
              month; its Hobbyist plan at $10 a month removes the interstitial. webhooks.cc includes{" "}
              <Link href="/docs/share" className="font-semibold hover:text-primary">
                whk share
              </Link>{" "}
              on every plan: Free shares get a random name ending in -free and a short notice page,
              for 2 hours at a time with 1 GB a month; Pro ($8 a month) keeps 3 reserved names, adds
              passwords and 25 GB a month, with no extra subscription. Previews serve web pages
              only: no downloads, video or TCP.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Scope and complexity</h3>
            <p className="text-muted-foreground">
              ngrok supports TCP tunnels, custom domains, traffic policies, IP restrictions, and
              edge computing, which go well beyond webhooks. If you need those, ngrok is the right
              tool. If your goal is to test and debug webhook integrations, webhooks.cc does that
              with less setup and more webhook-specific tooling. Team collaboration on webhooks.cc
              costs $12/seat/month, while ngrok&apos;s pay-as-you-go plan starts at $20/month with 3
              seats included and $5 per additional seat, plus metered usage.
            </p>
          </Card>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Full webhook request history with search and replay</li>
              <li>SDK assertions for webhook payloads in CI tests</li>
              <li>MCP integration for AI-assisted webhook workflows</li>
              <li>Mock responses returned to the webhook sender</li>
              <li>A tunnel that captures and inspects, not just forwards</li>
              <li>Email captured at its own address next to your webhooks</li>
              <li>A quick link to your local site, included in the plan you have</li>
            </ul>
          </Card>
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose ngrok when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>General-purpose tunneling for any protocol (HTTP, TCP, TLS)</li>
              <li>Your own domains for staging environments</li>
              <li>Traffic policies, IP restrictions, or edge compute</li>
              <li>Broad infrastructure tunneling beyond webhook testing</li>
            </ul>
          </Card>
        </div>

        {/* FAQ */}
        <h2 className="text-2xl font-bold mb-4">Frequently asked questions</h2>
        <div className="space-y-4 mb-4">
          {FAQ_ITEMS.map((item) => (
            <Card key={item.question}>
              <h3 className="font-bold mb-2">{item.question}</h3>
              <p className="text-muted-foreground text-sm">{item.answer}</p>
            </Card>
          ))}
        </div>

        {/* More comparisons */}
        <PairLinks tool="/compare/ngrok" />
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
            href="/compare/cloudflare-tunnel"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Cloudflare Tunnel
          </Link>
          {" · "}
          <Link
            href="/compare/pinggy"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Pinggy
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
