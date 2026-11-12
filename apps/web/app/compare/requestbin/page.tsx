import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";
import { CodeBox, InlineCode } from "@/components/ui/code";
import { Card } from "@/components/ui/card";

const FAQ_ITEMS = [
  {
    question: "What are the best RequestBin alternatives in 2026?",
    answer:
      "webhooks.cc is a strong RequestBin alternative for developers who want focused webhook and email testing without workflow code. It offers webhook and email capture, replay, SDKs for CI assertions in TypeScript, Python and Go, a CLI tunnel, forwarding to Slack, Discord, Google Sheets, Zapier or Make, and an MCP server, all open source. Other alternatives include Webhook.site (browser-based inspection), Beeceptor (API mocking), and Hookdeck (production webhook infrastructure).",
  },
  {
    question: "Is RequestBin shutting down?",
    answer:
      "Yes, with the rest of Pipedream Workflows. Pipedream announced that Workflows and String shut down on March 31, 2027: Workflows takes no new signups or subscriptions, existing workflows keep running until that date, and all Workflows data is deleted by April 30, 2027. requestbin.com already redirects to Pipedream's home page. If you capture webhooks or email there, move them before the cut-off.",
  },
  {
    question: "Is RequestBin still available as a standalone tool?",
    answer:
      "No. The original RequestBin was open source and self-hostable. It was acquired by Pipedream and became part of Pipedream's workflow platform, where requests are captured as workflow triggers, and that platform is now closing. Pipedream's focus has moved to Connect and MCP servers for its app integrations.",
  },
  {
    question: "How do I move from RequestBin to webhooks.cc?",
    answer:
      "Sign in and create an endpoint (you can also try one without an account), point your webhook senders at its https://go.webhooks.cc/w/{slug} URL, and send email to {slug}@mailhooks.cc, which every account endpoint receives. Where a workflow forwarded requests on, add a destination: your server, Slack or Discord, Google Sheets, or Zapier and Make for other apps. Where a workflow answered the sender, set a mock response or response rules. For code steps, forward to a small handler of your own.",
  },
  {
    question: "What is the difference between webhooks.cc and RequestBin?",
    answer:
      "webhooks.cc is a focused webhook testing platform: capture, inspect, replay, mock, tunnel to localhost, and assert on payloads in automated tests. RequestBin (Pipedream) captures requests as workflow triggers: the emphasis is on what happens after the webhook arrives (run code, call APIs, transform data). If you just need to test and debug webhooks, webhooks.cc is simpler. Pipedream Workflows, RequestBin included, takes no new signups and shuts down on March 31, 2027.",
  },
  {
    question: "Does webhooks.cc have workflow automation like Pipedream?",
    answer:
      "Not as code. webhooks.cc does not run your code or chain steps. Each endpoint can send what arrives to up to 10 destinations, each with its own filter: your server (as received, as signed JSON or as your own JSON template), Slack or Discord, Google Sheets, file drops to SFTP, FTP or S3 on Business, and Zapier or Make for everything else. Response rules choose the answer the sender gets, and layouts read fields, line items and attachments out of email. For multi-step logic, hand off to Zapier, Make or your own handler.",
  },
  {
    question: "Which RequestBin alternatives support longer retention and team access?",
    answer:
      "On webhooks.cc, Pro keeps requests for 31 days and Business for 90, and Teams shares endpoints with signed-in members only, at $12 per seat per month with 31-day retention for team-billed requests (Team Business: $35 per seat, 90 days). Guest URLs on any tool, webhooks.cc's included, can be read by anyone who has the address, so capture on account endpoints when the payloads matter.",
  },
];

const ROWS = [
  ["Status", "Active", "No new signups, shuts down March 31, 2027"],
  ["Primary focus", "Webhook & email testing", "Workflow automation platform"],
  ["Webhook capture", "Yes, full request storage", "Yes, as workflow trigger"],
  [
    "Inbound email capture",
    "Yes, {slug}@mailhooks.cc or your own domain",
    "Email trigger per workflow",
  ],
  ["Request inspection UI", "Yes, dedicated dashboard", "Yes, within workflow editor"],
  ["Mock responses", "Yes, rule-based with placeholders", "Yes, via workflow code"],
  ["CLI tunnel to localhost", "Yes (whk tunnel)", "No"],
  ["SDKs", "TypeScript, Python and Go", "No webhook-specific SDK"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  [
    "MCP server for AI agents",
    "Yes, remote (OAuth) or local",
    "For its app integrations, not bins",
  ],
  ["Request replay", "Yes, to any URL", "No (re-trigger workflow)"],
  ["Workflow automation", "No code steps", "Yes, core feature"],
  ["Third-party integrations", "Slack, Discord, Google Sheets, Zapier, Make", "Yes, 3,000+ apps"],
  ["Open source", "Yes (AGPL + MIT)", "No"],
  ["Team collaboration", "From $12/seat/mo, pooled quota", "All plans, free unlimited members"],
  ["Free tier features", "Every Pro feature", "Development only, daily credit cap"],
] as const;

export const metadata = createPageMetadata({
  title: "RequestBin Alternative: Open Source & Free (2026)",
  description:
    "RequestBin is closing with Pipedream Workflows in March 2027. An open-source alternative for webhooks and email: inspection, replay, SDKs for CI, a CLI tunnel and MCP.",
  path: "/compare/requestbin",
  keywords: [
    "requestbin alternative",
    "requestbin alternatives",
    "best requestbin alternative",
    "pipedream requestbin alternative",
    "webhooks.cc vs requestbin",
    "requestbin replacement",
    "webhook capture tool",
    "webhook testing tool",
  ],
});

export default function CompareRequestBinPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs RequestBin", path: "/compare/requestbin" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">
          webhooks.cc vs RequestBin (Pipedream)
        </h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you&apos;re looking for a RequestBin alternative, webhooks.cc picks up where the
          original RequestBin left off: a focused tool for capturing, inspecting, replaying, and
          testing webhooks and email. RequestBin became part of Pipedream&apos;s workflow platform,
          and Pipedream Workflows now takes no new signups and shuts down on March 31, 2027, with
          its data deleted by April 30, 2027. webhooks.cc stays developer-first with a CLI, SDKs for
          TypeScript, Python and Go, and an MCP server.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <CodeBox className="overflow-x-auto mb-10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
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
        </CodeBox>

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <Card>
            <h3 className="text-lg font-bold mb-2">Testing tool vs automation platform</h3>
            <p className="text-muted-foreground">
              webhooks.cc is built for development and testing: capture a webhook from Stripe,
              inspect the payload, replay it against your handler, write SDK assertions in CI.
              RequestBin (Pipedream) is built for production automation: receive a webhook,
              transform the data, call downstream APIs, store results. They solve adjacent but
              different problems.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Developer tooling</h3>
            <p className="text-muted-foreground">
              webhooks.cc includes a native CLI for tunneling webhooks to localhost, SDKs for
              TypeScript, Python and Go with <InlineCode>waitFor()</InlineCode> for test assertions,
              and an MCP server for AI agent integration. Team collaboration on webhooks.cc costs
              $12/seat/month, with each seat adding 100,000 pooled requests a month; Pipedream
              includes team features on all plans with unlimited members. RequestBin focuses on the
              Pipedream workflow editor and API, without webhook-specific dev tooling.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Open source</h3>
            <p className="text-muted-foreground">
              webhooks.cc is open source: the web app and receiver under AGPL-3.0, the CLI, SDKs and
              MCP server under MIT, so you can read exactly how your requests are handled. The
              original RequestBin was open source too; the Pipedream version is a closed, hosted
              platform.
            </p>
          </Card>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A focused webhook testing and debugging tool</li>
              <li>Request replay for re-triggering handlers</li>
              <li>SDK assertions in CI test suites</li>
              <li>CLI tunnel for local webhook development</li>
              <li>Open-source code you can inspect</li>
              <li>A home for RequestBin traffic before Pipedream Workflows closes</li>
            </ul>
          </Card>
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose RequestBin (Pipedream) when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Workflow automation triggered by webhooks</li>
              <li>Integrations with 3,000+ third-party apps</li>
              <li>Code execution steps after webhook receipt</li>
              <li>Production webhook processing, until Workflows closes in March 2027</li>
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
