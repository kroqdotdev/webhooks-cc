import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best Webhook.site alternatives in 2026?",
    answer:
      "webhooks.cc is a strong Webhook.site alternative for developers who need automated webhook testing. It adds SDKs with test assertions for TypeScript, Python and Go, a native CLI tunnel, an MCP server for AI coding agents, email parsing, and a free tier with every Pro feature, with Teams (invite members, share endpoints) billed separately from $12/seat/mo. Other alternatives include Beeceptor (API mocking focus) and Hookdeck (production webhook infrastructure).",
  },
  {
    question: "What is the main difference between webhooks.cc and Webhook.site?",
    answer:
      "Both tools capture and inspect incoming webhooks. webhooks.cc adds SDKs for TypeScript, Python and Go for writing webhook assertions in automated tests, forwarding to up to 10 destinations per endpoint with filters and retries, and an MCP server so AI coding agents can create, inspect, and replay webhooks programmatically. Both have a CLI that forwards to localhost.",
  },
  {
    question: "Does webhooks.cc have a free plan like Webhook.site?",
    answer:
      "Yes. The free plan has every Pro feature: inspection, replay, mock responses, CLI tunnel, SDK, and MCP. Paid plans raise request limits and retention, and Business adds attachment parsing, more layouts, custom inbound domains and file drops. Teams (invite members, share endpoints) is a separate per-team subscription: $12/seat/mo, or $35/seat/mo for Team Business with Business's limits per seat.",
  },
  {
    question: "Can I use webhooks.cc for CI/CD webhook testing?",
    answer:
      "Yes. The TypeScript SDK provides a waitFor() method that polls for incoming requests with configurable matchers (method, headers, body fields). You can assert on webhook payloads directly inside Vitest or Jest test suites, and the Python (wait_for, with pytest fixtures) and Go (WaitFor) SDKs do the same.",
  },
  {
    question: "Does webhooks.cc capture emails like Webhook.site?",
    answer:
      "Yes. Every endpoint on a webhooks.cc account, free included, has an email address at mailhooks.cc. Each email shows the one-time code and main link it contains and its SPF, DKIM and DMARC results, layouts read named fields, line items and attachments (CSV, Excel, PDF text) out of it, and forwarding posts it to your server as signed JSON with retries, or to Google Sheets, Slack, Zapier or Make. Business adds your own inbound domain. mailhooks.cc is the mail-first front door to the same accounts. Webhook.site gives every URL an email address without an account; acting on incoming email there takes Custom Actions, which are part of its paid plans.",
  },
  {
    question: "Does Webhook.site have an SDK or MCP server?",
    answer:
      "Webhook.site offers a REST API, a WebSocket API and a CLI, but no first-party SDK with test assertion helpers. It does not provide a first-party MCP server; the ones that exist are third-party.",
  },
  {
    question: "Which Webhook.site alternatives work for teams?",
    answer:
      "webhooks.cc Teams shares endpoints with signed-in team members, keeps team-billed requests for 31 days, and costs $12 per seat per month with 100,000 requests per seat pooled across the team. Team Business ($35 per seat per month) gives each seat Business's limits and keeps team traffic for 90 days. Webhook.site lists team features (multiple users, roles, SSO) on its Enterprise plan.",
  },
];

const ROWS = [
  ["Webhook capture & inspection", "Yes", "Yes"],
  [
    "Mock responses",
    "Yes, rule-based with placeholders",
    "Static on free, dynamic through paid Custom Actions",
  ],
  ["Request replay", "Yes", "Yes"],
  ["Search & filtering", "Yes", "Yes"],
  ["Export (JSON / CSV)", "Yes", "Yes"],
  ["CLI tunnel to localhost", "Yes", "Yes"],
  ["Email capture", "Yes, every account endpoint on every plan", "Yes, every URL"],
  [
    "Email fields and attachment parsing",
    "Yes, layouts on every plan (more on Business)",
    "Through Custom Actions (paid plans)",
  ],
  [
    "Email forwarded as signed JSON, with retries",
    "Yes, every plan",
    "Through Custom Actions (paid plans)",
  ],
  ["SDKs", "TypeScript, Python and Go", "No first-party SDK"],
  ["CI test assertions (waitFor)", "Yes", "No"],
  ["MCP server for AI agents", "Yes, remote (OAuth) or local", "No first-party server"],
  ["Request body matchers", "Yes (method, header, body path)", "No"],
  ["SSE real-time streaming", "Yes", "No"],
  ["Open source", "Yes (AGPL + MIT)", "MIT edition, without Custom Actions"],
  ["Team collaboration", "From $12/seat/mo, pooled quota", "Enterprise only, from $69/mo"],
  ["Free tier features", "Every Pro feature", "Some features paid-only"],
] as const;

export const metadata = createPageMetadata({
  title: "Webhook.site Alternative: Full Comparison (2026)",
  description:
    "Webhook.site alternative with SDKs for CI testing in TypeScript, Python and Go, a CLI tunnel to localhost, email parsing, and an MCP server for AI agents. Free tier has every Pro feature.",
  path: "/compare/webhook-site",
  keywords: [
    "webhook.site alternative",
    "webhook.site alternatives",
    "best webhook.site alternative",
    "webhooks.cc vs webhook.site",
    "webhook testing tool",
    "webhook inspection tool",
    "webhook sdk",
    "webhook mcp server",
    "webhook cli tunnel",
  ],
});

export default function CompareWebhookSitePage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Webhook.site", path: "/compare/webhook-site" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Webhook.site</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you&apos;re evaluating Webhook.site alternatives, here&apos;s the short version: both
          tools capture and inspect webhooks and email. webhooks.cc goes further with SDKs for CI
          test assertions in TypeScript, Python and Go, forwarding to up to 10 destinations, email
          parsing, and an MCP server for AI-assisted workflows, with every Pro feature on the free
          plan and Teams (invite members, share endpoints) billed separately from $12/seat/mo.
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
                  Webhook.site
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
            <h3 className="text-lg font-bold mb-2">SDK for automated testing</h3>
            <p className="text-muted-foreground">
              webhooks.cc publishes{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">@webhooks-cc/sdk</code> on
              npm. Use <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">waitFor()</code>{" "}
              to poll for incoming requests during integration tests, match on method, headers, or
              JSON body paths, and assert directly in Vitest or Jest. The Python SDK (with pytest
              fixtures) and the Go SDK run the same checks. Webhook.site offers an API and a CLI but
              no first-party SDK with built-in test helpers.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">MCP server for AI agents</h3>
            <p className="text-muted-foreground">
              The remote MCP server at webhooks.cc/mcp connects with one OAuth approval in the
              browser, and the local{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">@webhooks-cc/mcp</code>{" "}
              package exposes 48 tools to create endpoints, send test payloads, inspect captured
              requests, replay, generate payload types and more, so Claude Code, Cursor, Codex, or
              any MCP-compatible agent can drive webhook workflows without leaving the editor.
              Webhook.site has no first-party MCP server.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Email capture and forwarding</h3>
            <p className="text-muted-foreground">
              Both tools give you an email address to send test mail to. Webhook.site hands one out
              with every URL, no account needed. webhooks.cc gives one to every endpoint on an
              account, free included, picks out the one-time code and main link, and shows the SPF,
              DKIM and DMARC results. Layouts read named fields, line items and attachments (CSV,
              Excel, PDF text) out of each email, and forwarding posts it to your server as parsed
              JSON, signed with Standard Webhooks headers and retried for about a day, or to Google
              Sheets, Slack, Discord, Zapier or Make, on every plan. Business adds your own inbound
              domain and file drops to SFTP, FTP or S3. On Webhook.site, acting on incoming email
              takes Custom Actions, which are part of its paid plans. See{" "}
              <Link href="/email-testing" className="font-semibold hover:text-primary-ink">
                email testing
              </Link>{" "}
              and{" "}
              <Link href="/email-to-webhook" className="font-semibold hover:text-primary-ink">
                email to webhook
              </Link>
              .
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Pricing model</h3>
            <p className="text-muted-foreground">
              The free plan has every Pro feature. Teams (invite members, share endpoints) is its
              own per-team subscription at $12/seat/month, where each seat adds 100,000 pooled
              requests; Team Business is $35/seat/month with Business&apos;s limits per seat.
              Webhook.site reserves team collaboration for its Enterprise tier, starting at
              $69/month. Paid plans raise request limits and retention, and Business adds more
              parsed pages, more layouts, custom inbound domains and file drops. Webhook.site keeps
              Custom Actions, Schedules and Databases for its paid tiers (Basic, Pro and
              Enterprise).
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Webhook assertions in CI pipelines (SDK waitFor)</li>
              <li>AI agents that create, inspect, and replay webhooks (MCP)</li>
              <li>A CLI tunnel purpose-built for webhook forwarding</li>
              <li>Email capture with codes, links and sender checks</li>
              <li>Inbound email forwarded to your server as signed JSON, on the free plan</li>
              <li>Fields and attachments parsed out of email, on your own domain if you like</li>
              <li>Every Pro feature on the free plan, plus teams from $12/seat/mo</li>
              <li>Open-source codebase you can inspect</li>
            </ul>
          </div>
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose Webhook.site when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A well-established tool with a large existing user base</li>
              <li>Quick browser-only inspection with no install</li>
              <li>An email address without creating an account</li>
              <li>A self-hostable MIT edition of the core tool</li>
              <li>Familiarity: your team already uses it</li>
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
            href="/compare/ngrok"
            className="font-semibold hover:text-primary-ink transition-colors"
          >
            vs ngrok
          </Link>
          {" · "}
          <Link
            href="/compare/beeceptor"
            className="font-semibold hover:text-primary-ink transition-colors"
          >
            vs Beeceptor
          </Link>
          {" · "}
          <Link
            href="/compare/requestbin"
            className="font-semibold hover:text-primary-ink transition-colors"
          >
            vs RequestBin
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
