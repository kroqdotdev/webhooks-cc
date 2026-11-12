import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { ComparisonCTA } from "@/components/compare/comparison-cta";
import { InlineCode } from "@/components/ui/code";
import { Card } from "@/components/ui/card";

const FAQ_ITEMS = [
  {
    question: "What is a good Pinggy alternative for webhook testing?",
    answer:
      "webhooks.cc, when webhooks are the reason you want a tunnel. An endpoint has a fixed URL that captures and keeps every request, whk tunnel forwards each one to localhost, and the SDKs for TypeScript, Python and Go assert on what arrived in CI. Pinggy is the better fit for a plain tunnel with nothing to install, or for TCP and UDP.",
  },
  {
    question: "What is the difference between webhooks.cc and Pinggy?",
    answer:
      "Pinggy is a localhost tunnel you start with one ssh command: HTTP, TCP, UDP and TLS, with a Web Debugger that shows and replays live traffic. webhooks.cc is a webhook testing tool whose CLI also tunnels and shares: it stores every webhook whether or not your machine is on, replays it to any URL, and answers senders with mock responses or your local app's own answer.",
  },
  {
    question: "How do the free plans compare?",
    answer:
      "Pinggy's free plan lists a 60-minute tunnel timeout, random subdomains and unlimited data transfer, across HTTP, TCP, UDP and TLS, with request inspection and replay. webhooks.cc's free plan gives whk share a random name ending in -free for 2 hours at a time with 1 GB a month, and captures 50 webhooks a day, kept for 7 days. Pinggy's figures are from pinggy.io in November 2026.",
  },
  {
    question: "Does webhooks.cc work without installing anything, like Pinggy's ssh command?",
    answer:
      "No. Sharing and tunneling use the whk CLI, installed once and signed in with whk auth login. Capturing webhooks needs nothing installed: an endpoint URL works from the browser, the REST API, the SDKs or the MCP server.",
  },
  {
    question: "Can webhooks.cc tunnel TCP or UDP like Pinggy?",
    answer:
      "No. whk share serves web pages over HTTPS and whk tunnel carries webhooks; there are no TCP, UDP or TLS tunnels. For SSH, a database or a game server, Pinggy is the right tool.",
  },
  {
    question: "Which is cheaper for a link that stays the same?",
    answer:
      "Pinggy: Pro is $3 a month per seat ($2.50 billed annually) and includes one persistent subdomain and custom domain per seat. webhooks.cc Pro is $8 a month with 3 reserved names on sharehooks.cc and 25 GB of shared data, and the same plan raises webhook capture to 100,000 requests a month with 31-day history.",
  },
];

const ROWS = [
  ["Primary purpose", "Webhook testing, with a tunnel and share links", "Localhost tunnels"],
  [
    "Share a local site at a public link",
    "whk share 3000, after installing the CLI",
    "ssh -p 443 -R0:localhost:3000 free.pinggy.io, nothing to install",
  ],
  [
    "Free link",
    "A random -free name on sharehooks.cc",
    "A random name on run.pinggy-free.link, new on reconnect",
  ],
  ["Free session length", "2 hours", "60 minutes"],
  ["Free data", "1 GB a month", "Unlimited data transfer"],
  ["Notice page for browsers on free", "Yes, once a week per browser", "Yes, once per browser"],
  [
    "Stable names, paid",
    "Pro ($8/mo): 3 reserved names, 25 GB a month",
    "Pro ($3/mo per seat): 1 persistent subdomain and custom domain per seat",
  ],
  ["Your own domain", "No (inbound email only, on Business)", "Yes, on Pro"],
  [
    "Restricting who gets in",
    "Passwords on Pro and up (whk share --password)",
    "Basic auth, bearer key and IP whitelist",
  ],
  ["Protocols", "HTTP for webhooks and web pages, plus email; no TCP", "HTTP(S), TCP, UDP and TLS"],
  [
    "Webhook capture & history",
    "Yes, stored and searchable: dashboard, CLI, SDK, MCP",
    "Live traffic in the Web Debugger",
  ],
  [
    "A webhook sent while your machine is off",
    "Captured; replay it when you are back",
    "The tunnel must be running to receive it",
  ],
  [
    "Webhook sender gets your local app's answer",
    "Yes, with whk tunnel --live, and the request is kept",
    "Yes, the tunnel proxies the response",
  ],
  [
    "Request replay",
    "Yes, to any URL, from stored history",
    "Yes, replay or modify and replay in the Web Debugger",
  ],
  ["Mock responses", "Yes, rule-based per endpoint", "Not documented"],
  [
    "SDKs",
    "TypeScript, Python and Go, for test assertions",
    "Node.js and Python, for opening tunnels",
  ],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  [
    "MCP server for AI agents",
    "Yes, for testing: remote (OAuth) or local",
    "Yes, local, to open and manage tunnels; plus an agent skill",
  ],
  ["Team collaboration", "From $12/seat/mo, shared endpoints", "Teams on Pro, priced per seat"],
  ["Price", "Free; Pro $8/mo; Business $29/mo", "Free; Pro $3/mo per seat; Enterprise custom"],
] as const;

export const metadata = createPageMetadata({
  title: "Pinggy Alternative with Webhook History and Testing (2026)",
  description:
    "webhooks.cc vs Pinggy: stored webhook history, replay and CI assertions with a CLI tunnel and share links, against one-command SSH tunnels for HTTP, TCP and UDP.",
  path: "/compare/pinggy",
  keywords: [
    "pinggy alternative",
    "pinggy alternatives",
    "webhooks.cc vs pinggy",
    "pinggy free plan limits",
    "pinggy webhooks",
    "localhost tunnel alternative",
    "share localhost",
  ],
});

export default function ComparePinggyPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Pinggy", path: "/compare/pinggy" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Pinggy</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Pinggy opens a tunnel to localhost with one ssh command and nothing to install, for HTTP,
          TCP, UDP and TLS. webhooks.cc starts from the webhook instead: it captures every request
          at a fixed URL, keeps it, forwards it to your machine and lets a test assert on it, and
          its CLI can also{" "}
          <Link href="/share" className="text-primary font-bold hover:underline">
            share localhost
          </Link>{" "}
          at a public link. If you are looking for a Pinggy alternative for webhook work, this is
          how the two compare.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <ComparisonTable
          tools={[{ name: "webhooks.cc", ours: true }, { name: "Pinggy" }]}
          rows={ROWS}
          className="mb-3"
        />
        <p className="text-sm text-muted-foreground mb-10">
          Pinggy as listed on pinggy.io and in its docs in November 2026, monthly billing ($2.50 a
          seat billed annually); &quot;not documented&quot; means we did not find it there. Check
          its pricing before you buy.
        </p>

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <Card>
            <h3 className="text-lg font-bold mb-2">A tunnel, or a place webhooks are kept</h3>
            <p className="text-muted-foreground">
              Pinggy passes each request to your local port and shows it in its Web Debugger while
              the tunnel runs, where you can replay it or change it and replay. On the free plan the
              address changes whenever the tunnel reconnects, so a provider&apos;s webhook settings
              have to follow. A webhooks.cc endpoint keeps one URL and captures every request
              whether or not anything is running, for 7 days on Free and 31 on Pro;{" "}
              <InlineCode>whk tunnel</InlineCode> forwards each one to localhost, and{" "}
              <Link href="/docs/live-tunnel" className="font-semibold hover:text-primary">
                whk tunnel --live
              </Link>{" "}
              gives the sender your app&apos;s own answer.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Sharing a local site</h3>
            <p className="text-muted-foreground">
              Pinggy needs no download: an ssh command prints a public URL, with basic auth, a
              bearer key or an IP whitelist to restrict it. Its free tunnels end after 60 minutes,
              carry unlimited data and show browsers a screening page once; Pro, at $3 a month per
              seat, keeps a persistent subdomain and takes your own domain.{" "}
              <Link href="/docs/share" className="font-semibold hover:text-primary">
                whk share
              </Link>{" "}
              uses the whk CLI: Free shares run 2 hours at a time on a random name ending in -free,
              with 1 GB a month and a notice page once a week per browser; Pro ($8 a month) keeps 3
              reserved names, adds passwords and 25 GB a month. Shares serve web pages only.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Testing and CI</h3>
            <p className="text-muted-foreground">
              webhooks.cc provides SDKs for TypeScript, Python and Go with{" "}
              <InlineCode>waitFor()</InlineCode>: create an endpoint, trigger your integration, and
              assert on the captured webhook in your test suite, with no tunnel open in CI. It also
              sends signed test webhooks, checks provider signatures and returns mock responses.
              Pinggy&apos;s Node.js and Python SDKs open tunnels from code, and its MCP server lets
              an agent start and manage them.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Scope</h3>
            <p className="text-muted-foreground">
              Pinggy tunnels more than the web: TCP for SSH and databases, UDP for games and VoIP,
              and TLS passed through untouched, with persistent ports on Pro. webhooks.cc carries
              HTTP only, and adds email capture on the same endpoint. If you need a port rather than
              a webhook URL or a page, Pinggy is the right tool.
            </p>
          </Card>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A webhook URL that stays the same and keeps what arrives</li>
              <li>History you can search and replay days later</li>
              <li>SDK assertions on webhooks in CI</li>
              <li>Mock responses returned to the webhook sender</li>
              <li>Several reserved share names in one plan</li>
              <li>Email captured at its own address next to your webhooks</li>
            </ul>
          </Card>
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose Pinggy when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A tunnel from one ssh command, with nothing to install</li>
              <li>TCP, UDP or TLS tunnels</li>
              <li>Your own domain on the tunnel</li>
              <li>The lowest price for one persistent address</li>
              <li>Unlimited data transfer on a free tunnel</li>
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
            href="/compare/ngrok"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs ngrok
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
            href="/compare/localtunnel"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs LocalTunnel
          </Link>
          {" · "}
          <Link
            href="/compare/ngrok-vs-localtunnel"
            className="font-semibold hover:text-primary transition-colors"
          >
            ngrok vs LocalTunnel
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
