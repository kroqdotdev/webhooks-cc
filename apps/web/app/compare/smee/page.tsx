import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What is smee.io?",
    answer:
      "Smee.io is a free webhook payload delivery service made by the Probot team, the people behind the Probot framework for GitHub Apps. You start a channel on smee.io, give its URL to the webhook sender, and smee.io passes every payload it receives to the clients connected to that channel over Server-Sent Events. It is meant for development and testing, not production.",
  },
  {
    question: "How do I use smee.io to receive webhooks on localhost?",
    answer:
      "Open smee.io and choose Start a new channel, then use the channel URL as the webhook URL at the sender. Install the client with npm install --global smee-client and run smee --url <channel URL> --path /webhook --port 3000 (or --target with a full local URL). While the command runs, every payload sent to the channel is posted to your local server.",
  },
  {
    question: "What is smee-client?",
    answer:
      "smee-client is the npm package and smee command that connects to a smee.io channel and forwards each payload to a local URL, by default http://127.0.0.1:3000/. It also works as a Node library (new SmeeClient({ source, target })), and Probot connects to a channel by itself when WEBHOOK_PROXY_URL is set.",
  },
  {
    question: "Is smee.io free, and is it safe for production?",
    answer:
      "Smee.io is free and open source (the server is MIT, the client ISC), and you can host the server yourself. Its own README says not to use it in production: channels are not authenticated, so anyone who has the channel URL can see the payloads sent to it.",
  },
  {
    question: "Does smee.io store webhook payloads?",
    answer:
      "Not on the server. The smee.io README says payloads are never stored on the server or in a database; the channel page keeps the payloads you saw in your browser's localStorage, so they are there when you open the page again in that browser. A payload sent while no client is connected is not delivered later.",
  },
  {
    question: "What is the difference between smee.io and gh webhook forward?",
    answer:
      "gh webhook forward is a GitHub CLI extension (gh extension install cli/gh-webhook) that forwards GitHub webhooks to a local URL without a proxy channel. GitHub documents that it only works with repository and organization webhooks, is for testing and development only, and that only one person can forward for a repository or organization at a time. Smee.io accepts payloads from any sender but needs the channel URL configured as the webhook URL.",
  },
  {
    question: "What are the best Smee.io alternatives in 2026?",
    answer:
      "webhooks.cc is a Smee.io alternative that adds stored request history, replay to any URL, SDKs for CI test assertions in TypeScript, Python and Go, and an MCP server for AI agents on top of localhost forwarding. Other options include GitHub CLI's gh webhook forward (GitHub repository and organization webhooks only), ngrok (general-purpose tunnel), LocalTunnel (free open-source tunnel), and Webhook.site (browser-based inspection).",
  },
  {
    question: "What is the difference between webhooks.cc and Smee.io?",
    answer:
      "Smee.io is a pass-through: it delivers payloads to connected clients in real time and stores nothing on its server; the channel page keeps recent payloads in your browser, where you can filter them and redeliver one to the channel. webhooks.cc stores every request on the server, so deliveries that arrive while your machine is off are still there, and adds search, replay to any URL, a CLI tunnel, SDKs, an MCP server, mock responses, and email capture.",
  },
  {
    question: "Should I use Smee.io or webhooks.cc for GitHub App development?",
    answer:
      "Either works for forwarding GitHub webhooks to localhost. Smee.io is what GitHub's own tutorials use and is the simplest option if forwarding is all you need. webhooks.cc adds stored history, payload inspection, replay, and SDK assertions, useful if you want to inspect GitHub webhook payloads in detail or write automated tests for your GitHub App's webhook handler.",
  },
];

const SMEE_USAGE = `npm install --global smee-client

# forward a channel to http://127.0.0.1:3000/webhook
smee --url https://smee.io/YOUR_CHANNEL --path /webhook --port 3000`;

const GH_USAGE = `gh extension install cli/gh-webhook

gh webhook forward --repo=monalisa/octocat --events=issues,pull_request \\
  --url="http://localhost:3000/webhook"`;

const WHK_USAGE = `# create an endpoint and forward it to localhost:3000
whk tunnel 3000

# send a stored request again later
whk replay <request-id> --to http://localhost:3000/webhook`;

const ROWS = [
  ["Primary purpose", "Webhook testing platform", "Webhook proxy for localhost"],
  ["Webhook forwarding to localhost", "Yes (CLI tunnel)", "Yes (SSE client)"],
  ["Request history & storage", "Yes, persistent, searchable", "No, kept in your browser only"],
  ["Deliveries while your machine is off", "Stored, waiting for you", "Not delivered later"],
  ["Request inspection dashboard", "Yes", "Minimal (channel page)"],
  ["Mock responses", "Yes, rule-based per endpoint", "No"],
  ["Request replay", "Yes, to any URL", "Redeliver to the channel's clients"],
  ["Search & filtering", "Yes", "Filter box over the browser's payloads"],
  ["Export (JSON / CSV)", "Yes", "No"],
  ["SDKs", "TypeScript, Python and Go", "No (smee-client forwards only)"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  ["MCP server for AI agents", "Yes, remote (OAuth) or local", "No"],
  ["Inbound email capture", "Yes, {slug}@mailhooks.cc", "No"],
  ["Auth / user accounts", "Yes (optional)", "No, anonymous channels"],
  ["Open source", "Yes (AGPL + MIT)", "Yes (MIT server, ISC client)"],
  ["Team collaboration", "From $12/seat/mo, pooled quota", "None"],
  ["Free tier features", "Every Pro feature", "Free (fully open)"],
] as const;

export const metadata = createPageMetadata({
  title: "Smee.io: What It Is, How to Use It, and an Alternative",
  description:
    "What smee.io is, how smee-client forwards webhooks to localhost, how gh webhook forward compares, and an alternative that adds stored history, replay and CI tests.",
  path: "/compare/smee",
  keywords: [
    "smee.io",
    "what is smee.io",
    "smee-client",
    "smee webhook",
    "gh webhook forward",
    "smee.io alternative",
    "smee alternative",
    "smee.io alternatives",
    "best smee alternative",
    "webhooks.cc vs smee",
    "smee webhook proxy",
    "github webhook testing",
    "github app webhook development",
    "webhook localhost forwarding",
  ],
});

export default function CompareSmeePage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Smee.io", path: "/compare/smee" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">
          Smee.io: what it is, how to use it, and how webhooks.cc compares
        </h1>
        <p className="text-lg text-muted-foreground mb-10">
          Smee.io is a small, free service from the Probot team that passes webhook payloads on to
          your local machine. This page explains how it works and how to use it, then compares it
          with GitHub CLI&apos;s webhook forwarding and with webhooks.cc, which forwards to
          localhost too and also stores, searches, replays, and tests what arrived. Smee is simpler;
          webhooks.cc does more.
        </p>

        {/* What smee.io is */}
        <h2 className="text-2xl font-bold mb-4">What is smee.io?</h2>
        <div className="space-y-4 text-muted-foreground mb-10">
          <p>
            <a
              href="https://smee.io/"
              className="text-primary font-bold hover:underline"
              rel="noopener"
            >
              smee.io
            </a>{" "}
            calls itself a webhook payload delivery service: it &quot;receives payloads then sends
            them to your locally running application&quot;. It is made by the Probot team (Probot is
            the framework for building GitHub Apps), and GitHub&apos;s own webhook tutorials use it
            to get deliveries to a development machine. Both halves are open source: the{" "}
            <a
              href="https://github.com/probot/smee.io"
              className="text-primary font-bold hover:underline"
              rel="noopener"
            >
              smee.io server
            </a>{" "}
            and{" "}
            <a
              href="https://github.com/probot/smee-client"
              className="text-primary font-bold hover:underline"
              rel="noopener"
            >
              smee-client
            </a>
            .
          </p>
          <p>
            You start a channel on smee.io and get a unique URL. The webhook sender posts to that
            URL, and smee.io passes each payload over Server-Sent Events to every client connected
            to the channel at that moment: the channel page in your browser, and{" "}
            <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">smee-client</code>, which
            posts it on to your local server.
          </p>
          <p>Its limits, as its README states them:</p>
          <ul className="list-disc list-inside space-y-1.5">
            <li>
              It is for development and testing, not production, and not a proxy for production
              applications.
            </li>
            <li>
              Channels are not authenticated: anyone who has the channel URL can see the payloads
              sent to it.
            </li>
            <li>
              Payloads are never stored on the server. They go only to clients that are connected
              when they arrive, and the channel page keeps the ones you saw in your browser&apos;s
              localStorage.
            </li>
          </ul>
        </div>

        {/* How to use it */}
        <h2 className="text-2xl font-bold mb-4">How to use smee.io with smee-client</h2>
        <div className="space-y-4 text-muted-foreground mb-10">
          <p>
            Open smee.io, choose <strong>Start a new channel</strong>, and set the channel URL as
            the webhook URL at the sender. Then install the client and point it at your local
            server:
          </p>
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{SMEE_USAGE}</code>
            </pre>
          </div>
          <p>
            <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">--target</code> takes a full
            local URL instead of a port and path; without options the client forwards to{" "}
            <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">
              http://127.0.0.1:3000/
            </code>
            . The client posts each payload to your server as JSON with the sender&apos;s headers.
            Probot apps need no client: set{" "}
            <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">WEBHOOK_PROXY_URL</code> to
            the channel URL.
          </p>
        </div>

        {/* gh webhook forward */}
        <h2 className="text-2xl font-bold mb-4">GitHub only? gh webhook forward</h2>
        <div className="space-y-4 text-muted-foreground mb-10">
          <p>
            For GitHub webhooks, the GitHub CLI has an extension that forwards deliveries to a local
            URL without a channel or a webhook URL to configure:
          </p>
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{GH_USAGE}</code>
            </pre>
          </div>
          <p>
            <a
              href="https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing"
              className="text-primary font-bold hover:underline"
              rel="noopener"
            >
              GitHub&apos;s docs
            </a>{" "}
            list its limits: it only works with repository and organization webhooks (use{" "}
            <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">--org</code>, with the{" "}
            <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">admin:org_hook</code> scope,
            for an organization), not with other kinds such as a GitHub App&apos;s; it is for
            testing and development only; and only one person can forward for a repository or
            organization at a time (a second gets{" "}
            <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">Hook already exists</code>).
          </p>
        </div>

        {/* webhooks.cc */}
        <h2 className="text-2xl font-bold mb-4">The same job with webhooks.cc</h2>
        <div className="space-y-4 text-muted-foreground mb-10">
          <p>
            <Link href="/docs/cli/tunnel" className="text-primary font-bold hover:underline">
              whk tunnel
            </Link>{" "}
            creates an endpoint, prints its URL, and forwards every request to your local port, from
            any sender. The difference from Smee is that the endpoint stores what it receives: a
            webhook that arrives while your laptop is closed is in the dashboard when you come back,
            and you can search it, replay it to any URL, or assert on it in a test.
          </p>
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{WHK_USAGE}</code>
            </pre>
          </div>
        </div>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <div className="ui-code overflow-x-auto mb-10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="text-left py-2.5 pr-4 font-bold">
                  Feature
                </th>
                <th scope="col" className="text-left py-2.5 pr-4 font-bold">
                  webhooks.cc
                </th>
                <th scope="col" className="text-left py-2.5 font-bold">
                  Smee.io
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
            <h3 className="text-lg font-bold mb-2">Proxy vs platform</h3>
            <p className="text-muted-foreground">
              Smee.io does one thing: pass incoming webhooks to connected clients via SSE. Its
              server stores nothing; the channel page keeps recent payloads only in your own
              browser, where you can filter them and redeliver one to the channel. webhooks.cc
              stores every request with full headers, body, and metadata: searchable, exportable,
              and replayable to any URL from the dashboard, CLI, or SDK.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Developer tooling</h3>
            <p className="text-muted-foreground">
              webhooks.cc provides SDKs for TypeScript, Python and Go for programmatic access and CI
              test assertions, a native CLI with built-in tunneling, and an MCP server for AI coding
              agents. For teams, webhooks.cc shares endpoints across a team at $12/seat/month;
              Smee.io has no team or collaboration features. Smee.io provides a small npm client (
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">smee-client</code>) for
              forwarding: no SDK, no test helpers, no MCP.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">GitHub App development</h3>
            <p className="text-muted-foreground">
              Smee.io comes from the Probot team and is the proxy GitHub&apos;s own webhook and
              GitHub App tutorials use. It works well for that narrow use case. If you need to go
              beyond forwarding (inspect payloads across multiple webhook sources, replay failed
              deliveries, or assert on GitHub event payloads in tests), webhooks.cc covers the
              broader workflow.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Persistent request history with search and export</li>
              <li>Replay captured webhooks against your handler</li>
              <li>SDK assertions in automated test suites</li>
              <li>Mock responses returned to webhook senders</li>
              <li>MCP integration for AI-assisted development</li>
              <li>Multiple webhook sources beyond GitHub</li>
            </ul>
          </div>
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose Smee.io when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>The simplest possible localhost forwarding</li>
              <li>Quick GitHub App development with zero setup</li>
              <li>No account, no auth: just a URL and a client</li>
              <li>Open-source proxy you can self-host</li>
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
            href="/compare/localtunnel"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs LocalTunnel
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
