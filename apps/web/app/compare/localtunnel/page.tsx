import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";
import { CodeBox } from "@/components/ui/code";
import { Card } from "@/components/ui/card";
import { PairLinks } from "@/components/compare/pair-links";

const FAQ_ITEMS = [
  {
    question: "What are the best LocalTunnel alternatives in 2026?",
    answer:
      "webhooks.cc is a strong LocalTunnel alternative if you need webhook-specific tooling: it tunnels to localhost and also captures, inspects, replays, and tests every request, and whk share puts a local site at a public link. Other alternatives include ngrok (general-purpose tunnel with paid plans), Pinggy (tunnels over SSH), Smee.io (GitHub's webhook proxy), and Cloudflare Tunnel (tunnels to your own domain on Cloudflare).",
  },
  {
    question: "What is LocalTunnel?",
    answer:
      "LocalTunnel is a free, open-source tool that exposes your local server to the internet via a public URL. It is a lightweight alternative to ngrok for quick localhost sharing during development.",
  },
  {
    question: "What is the difference between webhooks.cc and LocalTunnel?",
    answer:
      "LocalTunnel is a generic tunnel: it forwards traffic to localhost but does not capture, store, or inspect requests. webhooks.cc is a webhook testing platform: it captures every incoming request with headers, body, and metadata, stores them for inspection, and provides replay, SDK assertions, and MCP tooling, and its CLI shares a local site too. If you only need to forward traffic with no account, LocalTunnel works. If you need to see, search, and test what arrived, webhooks.cc is the better fit.",
  },
  {
    question: "Is LocalTunnel still maintained?",
    answer:
      "The client's latest release on npm, 2.0.2, is from September 2021, and the most recent commit in its GitHub repository, a README update, is from August 2025. It is a free community project with no support plan, and its URL changes on each restart unless the subdomain you ask for is free. For a webhook URL that stays put, host the LocalTunnel server yourself or use a tool with fixed endpoint URLs, like webhooks.cc.",
  },
  {
    question: "Can I use webhooks.cc as a free ngrok/LocalTunnel alternative?",
    answer:
      "Yes. The webhooks.cc CLI tunnel (whk tunnel) forwards webhooks to your local port on the free plan with no time limit, and you also get persistent request history, inspection, replay, and test assertions. Sharing a local site with whk share is on the free plan too, within limits: one share at a time on a random name ending in -free, for 2 hours, with 1 GB a month.",
  },
  {
    question: "Can webhooks.cc share a local website like lt --port?",
    answer:
      "Yes. whk share 3000 puts your local site at an HTTPS link on sharehooks.cc, with WebSockets and live reload passing through. It needs a free account and the whk CLI. Pro ($8/month) keeps 3 reserved names between sessions, adds passwords and 25 GB a month. Shares serve web pages only, with no downloads, video or TCP.",
  },
];

const ROWS = [
  ["Primary purpose", "Webhook testing platform", "Free localhost tunnel"],
  ["Tunnel to localhost", "Yes (whk tunnel)", "Yes (lt --port)"],
  ["Share a local site at a public link", "Yes (whk share, on sharehooks.cc)", "Yes (lt --port)"],
  ["Account", "Yes, free", "None"],
  [
    "Free share link",
    "A random -free name, 2-hour sessions, 1 GB a month",
    "A random loca.lt name for as long as the command runs",
  ],
  [
    "Webhook sender gets your local app's answer",
    "Yes, with whk tunnel --live, and the request is kept",
    "Yes, the tunnel proxies the response",
  ],
  ["Webhook capture & history", "Yes, persistent, searchable", "No"],
  ["Request inspection", "Yes, dashboard + CLI + SDK", "No"],
  ["Mock responses", "Yes, rule-based per endpoint", "No"],
  ["Request replay", "Yes", "No"],
  ["Search & filtering", "Yes", "No"],
  ["SDKs", "TypeScript, Python and Go", "No"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  ["MCP server for AI agents", "Yes, remote (OAuth) or local", "No"],
  ["Stable webhook URL", "Yes, slug-based", "No, random per session"],
  [
    "A share name you choose",
    "Pro ($8/mo): 3 reserved names",
    "--subdomain, when the name is free",
  ],
  ["Password on a shared link", "Pro and up", "Not documented"],
  ["Non-HTTP protocols", "Email capture (no TCP tunnels)", "No (HTTP only)"],
  ["Open source", "Yes (AGPL + MIT)", "Yes (MIT)"],
  ["Maintenance", "Active", "Last client release 2021"],
  ["Team collaboration", "From $12/seat/mo, pooled quota", "None"],
  ["Free tier features", "Every webhook feature; share names and passwords need Pro", "Fully free"],
] as const;

export const metadata = createPageMetadata({
  title: "LocalTunnel Alternative: Share Localhost, Test Webhooks (2026)",
  description:
    "LocalTunnel alternative that keeps what arrives: webhook capture, inspection and replay, a CLI tunnel, share links for a local site, SDK assertions and an MCP server.",
  path: "/compare/localtunnel",
  keywords: [
    "localtunnel alternative",
    "localtunnel alternatives",
    "best localtunnel alternative",
    "webhooks.cc vs localtunnel",
    "free ngrok alternative",
    "localhost tunnel alternative",
    "webhook tunnel free",
    "localtunnel webhook testing",
    "free webhook testing",
    "share localhost",
  ],
});

export default function CompareLocalTunnelPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs LocalTunnel", path: "/compare/localtunnel" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs LocalTunnel</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you need a LocalTunnel alternative with webhook inspection built in, webhooks.cc gives
          you a free public URL that forwards traffic to localhost, and also captures every request,
          stores it for inspection, and lets you replay, search, and assert on payloads. Its CLI can
          also{" "}
          <Link href="/share" className="text-primary font-bold hover:underline">
            share localhost
          </Link>{" "}
          at a public link, the job LocalTunnel is best known for. Same starting point, different
          depth.
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
                  LocalTunnel
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
          LocalTunnel as described on its site, its GitHub README and npm in November 2026;
          &quot;not documented&quot; means we did not find it there.
        </p>

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <Card>
            <h3 className="text-lg font-bold mb-2">Tunnel vs testing platform</h3>
            <p className="text-muted-foreground">
              LocalTunnel opens a pipe from the internet to your local port. What goes through the
              pipe is not stored, indexed, or searchable. webhooks.cc captures every request that
              arrives: you can search headers, inspect JSON bodies, export to CSV, and replay
              requests days later. The tunnel is one feature; the platform builds on top of it.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">An address that lasts</h3>
            <p className="text-muted-foreground">
              A LocalTunnel URL lives for one session: restart <code>lt</code> and the name changes,
              unless the subdomain you ask for happens to be free, so a webhook sender has to be
              pointed at the new one each time. The client has had no release since 2021.
              webhooks.cc endpoints use stable slug-based URLs on managed infrastructure and keep
              capturing while your machine is off, so you configure a webhook sender once.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Sharing a local site</h3>
            <p className="text-muted-foreground">
              LocalTunnel does this with no account: one command, a random loca.lt name, and the
              link works while the command runs. webhooks.cc includes{" "}
              <Link href="/docs/share" className="font-semibold hover:text-primary">
                whk share
              </Link>{" "}
              on every plan, behind a free account: Free shares get a random name ending in -free
              and a short notice page, for 2 hours at a time with 1 GB a month; Pro ($8 a month)
              keeps 3 reserved names, adds passwords and 25 GB a month. Shares serve web pages only:
              no downloads, video or TCP.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Beyond the tunnel</h3>
            <p className="text-muted-foreground">
              webhooks.cc adds SDKs for CI test assertions in TypeScript, Python and Go, an MCP
              server for AI coding agents, configurable mock responses, email capture, and a
              real-time dashboard. For teams, webhooks.cc shares endpoints across a team at
              $12/seat/month; LocalTunnel has no team or collaboration features. LocalTunnel is a
              single-purpose tool, and that simplicity is its strength for quick, throwaway
              tunneling.
            </p>
          </Card>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Persistent request history, not just forwarding</li>
              <li>Search, filter, and export captured webhooks</li>
              <li>Replay requests against your handler for debugging</li>
              <li>SDK assertions in CI test suites</li>
              <li>Stable endpoint URLs that persist across sessions</li>
              <li>MCP tooling for AI-assisted webhook workflows</li>
              <li>A share name that stays yours, with a password on it</li>
            </ul>
          </Card>
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose LocalTunnel when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>The simplest, fastest localhost tunnel with no signup</li>
              <li>Throwaway URLs for quick demos or pairing sessions</li>
              <li>Zero-dependency, fully open-source MIT tunnel</li>
              <li>A quick share with no account and no session limit</li>
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
        <PairLinks tool="/compare/localtunnel" />
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
            href="/compare/pinggy"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Pinggy
          </Link>
          {" · "}
          <Link href="/compare/smee" className="font-semibold hover:text-primary transition-colors">
            vs Smee.io
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
