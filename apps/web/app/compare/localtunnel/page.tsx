import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What are the best LocalTunnel alternatives in 2026?",
    answer:
      "webhooks.cc is a strong LocalTunnel alternative if you need webhook-specific tooling: it tunnels to localhost and also captures, inspects, replays, and tests every request. Other alternatives include ngrok (general-purpose tunnel with paid features), Smee.io (GitHub's webhook proxy), and Cloudflare Tunnel (production-grade zero-trust tunnel).",
  },
  {
    question: "What is LocalTunnel?",
    answer:
      "LocalTunnel is a free, open-source tool that exposes your local server to the internet via a public URL. It is a lightweight alternative to ngrok for quick localhost sharing during development.",
  },
  {
    question: "What is the difference between webhooks.cc and LocalTunnel?",
    answer:
      "LocalTunnel is a generic tunnel — it forwards traffic to localhost but does not capture, store, or inspect requests. webhooks.cc is a webhook testing platform — it captures every incoming request with headers, body, and metadata, stores them for inspection, and provides replay, SDK assertions, and MCP tooling. If you only need to forward traffic, LocalTunnel works. If you need to see, search, and test what arrived, webhooks.cc is the better fit.",
  },
  {
    question: "Is LocalTunnel reliable?",
    answer:
      "LocalTunnel is free and community-maintained. The public server can be unreliable during high-traffic periods, and URLs change on each restart. For consistent development workflows, self-hosting the LocalTunnel server or using a tool with managed infrastructure (like webhooks.cc) provides more stability.",
  },
  {
    question: "Can I use webhooks.cc as a free ngrok/LocalTunnel alternative?",
    answer:
      "Yes. The webhooks.cc CLI tunnel (whk tunnel) forwards webhooks to your local port, and the free tier includes this feature with no time limits. Unlike LocalTunnel, you also get persistent request history, inspection, replay, and test assertions included.",
  },
];

const ROWS = [
  ["Primary purpose", "Webhook testing platform", "Free localhost tunnel"],
  ["Tunnel to localhost", "Yes (whk tunnel)", "Yes (lt --port)"],
  ["Webhook capture & history", "Yes — persistent, searchable", "No"],
  ["Request inspection", "Yes — dashboard + CLI + SDK", "No"],
  ["Mock responses", "Yes — per endpoint", "No"],
  ["Request replay", "Yes", "No"],
  ["Search & filtering", "Yes", "No"],
  ["TypeScript SDK", "Yes — @webhooks-cc/sdk", "No"],
  ["CI test assertions", "Yes (waitFor + matchers)", "No"],
  ["MCP server for AI agents", "Yes — @webhooks-cc/mcp", "No"],
  ["Stable URLs", "Yes — slug-based", "No — random per session"],
  ["Custom subdomains", "No", "Yes (often unavailable)"],
  ["Non-HTTP protocols", "No (HTTP webhooks only)", "No (HTTP only)"],
  ["Open source", "Yes (AGPL + MIT)", "Yes (MIT)"],
  ["Free tier", "All features, rate-limited", "Fully free"],
] as const;

export const metadata = createPageMetadata({
  title: "LocalTunnel Alternative with Webhook Testing (2026)",
  description:
    "Need a LocalTunnel alternative with webhook inspection? webhooks.cc captures, stores, and replays requests with SDK assertions and MCP for AI agents. Free, all features included, open source.",
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
  ],
});

export default function CompareLocalTunnelPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs LocalTunnel", path: "/compare/localtunnel" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
          Comparison · Updated March 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs LocalTunnel</h1>
        <p className="text-lg text-muted-foreground mb-10">
          If you need a LocalTunnel alternative with webhook inspection built in, webhooks.cc gives
          you a free public URL that forwards traffic to localhost — and also captures every request,
          stores it for inspection, and lets you replay, search, and assert on payloads. Same
          starting point, different depth.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <div className="neo-code overflow-x-auto mb-10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-foreground">
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
        </div>

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Tunnel vs testing platform</h3>
            <p className="text-muted-foreground">
              LocalTunnel opens a pipe from the internet to your local port. What goes through the
              pipe is not stored, indexed, or searchable. webhooks.cc captures every request that
              arrives — you can search headers, inspect JSON bodies, export to CSV, and replay
              requests days later. The tunnel is one feature; the platform builds on top of it.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Reliability</h3>
            <p className="text-muted-foreground">
              LocalTunnel&apos;s public server is community-run and can be unreliable. URLs change every
              session, and connections sometimes drop. webhooks.cc endpoints use stable slug-based
              URLs and run on managed infrastructure, so you can configure a webhook sender once and
              keep receiving.
            </p>
          </div>

          <div className="neo-card neo-card-static">
            <h3 className="text-lg font-bold mb-2">Beyond the tunnel</h3>
            <p className="text-muted-foreground">
              webhooks.cc adds a TypeScript SDK for CI test assertions, an MCP server for AI coding
              agents, configurable mock responses, and a real-time dashboard. LocalTunnel is a
              single-purpose tool — and that simplicity is its strength for quick, throwaway
              tunneling.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Persistent request history, not just forwarding</li>
              <li>Search, filter, and export captured webhooks</li>
              <li>Replay requests against your handler for debugging</li>
              <li>SDK assertions in CI test suites</li>
              <li>Stable endpoint URLs that persist across sessions</li>
              <li>MCP tooling for AI-assisted webhook workflows</li>
            </ul>
          </div>
          <div className="neo-card neo-card-static">
            <h2 className="text-xl font-bold mb-3">Choose LocalTunnel when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>The simplest, fastest localhost tunnel with no signup</li>
              <li>Throwaway URLs for quick demos or pairing sessions</li>
              <li>Zero-dependency, fully open-source MIT tunnel</li>
              <li>Non-webhook use cases (sharing local web apps)</li>
            </ul>
          </div>
        </div>

        {/* FAQ */}
        <h2 className="text-2xl font-bold mb-4">Frequently asked questions</h2>
        <div className="space-y-4 mb-4">
          {FAQ_ITEMS.map((item) => (
            <div key={item.question} className="neo-card neo-card-static">
              <h3 className="font-bold mb-2">{item.question}</h3>
              <p className="text-muted-foreground text-sm">{item.answer}</p>
            </div>
          ))}
        </div>

        {/* More comparisons */}
        <p className="text-sm text-muted-foreground mb-0">
          See also:{" "}
          <Link href="/compare/ngrok" className="font-semibold hover:text-primary transition-colors">
            vs ngrok
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
