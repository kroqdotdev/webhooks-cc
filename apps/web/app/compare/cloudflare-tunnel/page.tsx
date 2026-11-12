import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";
import { CodeBox, InlineCode } from "@/components/ui/code";
import { Card } from "@/components/ui/card";
import { PairLinks } from "@/components/compare/pair-links";

const FAQ_ITEMS = [
  {
    question: "What is a good Cloudflare Tunnel alternative for webhook testing?",
    answer:
      "webhooks.cc, when the job is testing webhooks rather than publishing a service. An endpoint has a fixed URL that captures and keeps every request, whk tunnel forwards each one to localhost, and whk tunnel --live returns your local app's answer to the sender. Cloudflare Tunnel is the better tool for putting a server on your own domain behind Cloudflare.",
  },
  {
    question: "What is the difference between webhooks.cc and Cloudflare Tunnel?",
    answer:
      "Cloudflare Tunnel connects a service to Cloudflare's network: cloudflared runs next to it and maps hostnames on your own domain to local addresses, with Cloudflare's CDN, WAF and DDoS protection in front. webhooks.cc is a webhook testing tool whose CLI also tunnels: it stores every webhook, replays it, asserts on it in CI, and shares a local site at a link on sharehooks.cc.",
  },
  {
    question: "Can I use a Cloudflare Quick Tunnel for webhooks?",
    answer:
      "Yes, for a quick test: cloudflared tunnel --url http://localhost:8080 gives a trycloudflare.com address with no account. Cloudflare's docs say the hostname changes each time you create one, that there is no uptime guarantee, and that Quick Tunnels do not support Server-Sent Events, so the URL you gave the provider has to be updated on every run. A webhooks.cc endpoint keeps one URL and stores what arrives while nothing is running.",
  },
  {
    question: "Can webhooks.cc share a local site like cloudflared tunnel --url?",
    answer:
      "Yes. whk share 3000 puts a local site at an HTTPS link on sharehooks.cc, with WebSockets and live reload passing through. It needs a free account; Free shares get a random name ending in -free, last 2 hours and include 1 GB a month, and Pro ($8/month) keeps 3 reserved names, adds passwords and 25 GB a month. A Quick Tunnel needs no account and gives a new random trycloudflare.com name each time.",
  },
  {
    question: "Does webhooks.cc support my own domain, TCP or SSH like Cloudflare Tunnel?",
    answer:
      "No. Shares live on sharehooks.cc and serve web pages only, webhooks arrive on go.webhooks.cc, and there are no TCP or SSH tunnels; your own domain is supported for inbound email only, on Business. If you need a service on your own hostname, or SSH and RDP, Cloudflare Tunnel is the right tool.",
  },
  {
    question: "Is Cloudflare Tunnel free?",
    answer:
      "Cloudflare's docs list Cloudflare Tunnel as available on all plans, and a Quick Tunnel needs no account. Publishing an application on a tunnel needs a Cloudflare account and a domain on Cloudflare. webhooks.cc has a free plan with 50 requests a day and every Pro feature, including whk tunnel and whk share.",
  },
];

const ROWS = [
  [
    "Primary purpose",
    "Webhook testing, with a tunnel and share links",
    "Connecting services to Cloudflare's network",
  ],
  [
    "Share a local site at a public link",
    "Yes (whk share, on sharehooks.cc)",
    "Yes (Quick Tunnel, on trycloudflare.com)",
  ],
  ["Account for a quick link", "Yes, free", "No"],
  [
    "Free link",
    "A random -free name, 2-hour sessions, 1 GB a month",
    "A random name, new every time; 200 requests in flight; no uptime guarantee",
  ],
  [
    "Stable name",
    "Pro ($8/mo): 3 reserved names on sharehooks.cc",
    "A hostname on your own domain on Cloudflare",
  ],
  ["Your own domain", "No (inbound email only, on Business)", "Yes, needed to publish"],
  [
    "Restricting who gets in",
    "Passwords on Pro and up (whk share --password)",
    "Email one-time PIN on Quick Tunnels, for browser visitors only; Cloudflare Access on a tunnel",
  ],
  ["Webhook capture & history", "Yes, stored and searchable", "Not documented"],
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
  ["Request replay", "Yes, to any URL", "Not documented"],
  ["Mock responses", "Yes, rule-based per endpoint", "Not documented"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  [
    "MCP server for AI agents",
    "Yes, for testing: remote (OAuth) or local",
    "Cloudflare's own MCP servers, for its platform",
  ],
  [
    "Protocols",
    "HTTP for webhooks and web pages, plus email; no TCP",
    "HTTP on Quick Tunnels; TCP, SSH and RDP on a tunnel, with cloudflared on the client too",
  ],
  [
    "Production traffic",
    "No, built for development and demos",
    "Yes, with CDN, WAF and DDoS protection",
  ],
  ["Open source", "Yes (AGPL + MIT)", "cloudflared (Apache 2.0)"],
  ["Price", "Free; Pro $8/mo; Business $29/mo", "Listed as available on all Cloudflare plans"],
] as const;

export const metadata = createPageMetadata({
  title: "Cloudflare Tunnel Alternative for Webhooks and Demos (2026)",
  description:
    "webhooks.cc vs Cloudflare Tunnel: a webhook URL that keeps every request and a share link with no domain to set up, against tunnels to your own domain on Cloudflare.",
  path: "/compare/cloudflare-tunnel",
  keywords: [
    "cloudflare tunnel alternative",
    "cloudflare tunnel alternatives",
    "cloudflared alternative",
    "trycloudflare alternative",
    "webhooks.cc vs cloudflare tunnel",
    "cloudflare tunnel webhooks",
    "cloudflare quick tunnel limits",
    "share localhost",
  ],
});

export default function CompareCloudflareTunnelPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Cloudflare Tunnel", path: "/compare/cloudflare-tunnel" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Cloudflare Tunnel</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Cloudflare Tunnel connects a service to Cloudflare&apos;s network and publishes it on your
          own domain; its Quick Tunnels give a throwaway trycloudflare.com address for testing. If
          what you want is to test webhooks on localhost or to{" "}
          <Link href="/share" className="text-primary font-bold hover:underline">
            share localhost
          </Link>{" "}
          with a client, webhooks.cc is a Cloudflare Tunnel alternative that needs no domain: it
          keeps every webhook, forwards it to your machine, and shares a local site with one
          command.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <CodeBox className="overflow-x-auto mb-3">
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
                  Cloudflare Tunnel
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
        <p className="text-sm text-muted-foreground mb-10">
          Cloudflare Tunnel as described on developers.cloudflare.com/tunnel in November 2026;
          &quot;not documented&quot; means we did not find it there.
        </p>

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <Card>
            <h3 className="text-lg font-bold mb-2">Webhooks: stored first, or passed through</h3>
            <p className="text-muted-foreground">
              A tunnel hands each request to your local app and keeps nothing: Cloudflare&apos;s
              Tunnel docs describe no request inspector or replay, and a request sent while
              cloudflared is stopped has nowhere to go. webhooks.cc captures every webhook at a
              fixed URL first (headers, body, query, timing) and keeps it for 7 days on Free and 31
              on Pro. <InlineCode>whk tunnel</InlineCode> then forwards each one to localhost, and{" "}
              <Link href="/docs/live-tunnel" className="font-semibold hover:text-primary">
                whk tunnel --live
              </Link>{" "}
              makes the sender wait for your app&apos;s own answer, the way a tunnel does.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">A quick link to a local site</h3>
            <p className="text-muted-foreground">
              Both do it with one command. A Quick Tunnel needs no account and gives a random
              trycloudflare.com name that changes every time, with no uptime guarantee, at most 200
              requests in flight and no Server-Sent Events; an email one-time PIN can restrict who
              opens it.{" "}
              <Link href="/docs/share" className="font-semibold hover:text-primary">
                whk share
              </Link>{" "}
              needs a free account: Free shares get a random name ending in -free and a short notice
              page, for 2 hours at a time with 1 GB a month, and Pro ($8 a month) keeps 3 reserved
              names, adds passwords and 25 GB a month. Shares serve web pages only: no downloads,
              video or TCP.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Your own domain, or none to set up</h3>
            <p className="text-muted-foreground">
              A lasting address on Cloudflare Tunnel is a hostname on a domain you keep on
              Cloudflare, which suits a service you run for good and is more than a demo needs.
              webhooks.cc has no DNS step: webhook URLs live on go.webhooks.cc and shares on
              sharehooks.cc, and a reserved name such as acme.sharehooks.cc stays yours between
              sessions. It cannot put a share on your own domain.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Testing, or running a service</h3>
            <p className="text-muted-foreground">
              webhooks.cc adds what a test needs: SDKs for TypeScript, Python and Go with{" "}
              <InlineCode>waitFor()</InlineCode> for assertions in CI, mock responses, signature
              checks, email capture and an MCP server. Cloudflare Tunnel is infrastructure: HTTP,
              TCP, SSH and RDP, replicas for availability, and Cloudflare&apos;s CDN, WAF and DDoS
              protection in front. If you are putting a server online, use Cloudflare Tunnel.
            </p>
          </Card>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A webhook URL that stays the same and keeps what arrives</li>
              <li>Search, replay and mock responses for webhooks</li>
              <li>SDK assertions on webhooks in CI</li>
              <li>A link to a local site with no domain or DNS to set up</li>
              <li>The same share name next week, without owning a domain</li>
              <li>Email captured at its own address next to your webhooks</li>
            </ul>
          </Card>
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose Cloudflare Tunnel when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A service published on your own domain</li>
              <li>Production traffic behind a CDN, WAF and DDoS protection</li>
              <li>TCP, SSH or RDP, not only HTTP</li>
              <li>A service that stays up, with replicas for availability</li>
              <li>A one-off link with no account at all</li>
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
        <PairLinks tool="/compare/cloudflare-tunnel" />
        <p className="text-sm text-muted-foreground mb-0">
          See also:{" "}
          <Link
            href="/compare/ngrok-vs-cloudflare-tunnel"
            className="font-semibold hover:text-primary transition-colors"
          >
            ngrok vs Cloudflare Tunnel
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
            href="/compare/pinggy"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Pinggy
          </Link>
          {" · "}
          <Link
            href="/compare/localtunnel"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs LocalTunnel
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
