import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema, type FAQItem } from "@/lib/schemas";
import { FAQAccordion } from "@/components/landing/faq-accordion";

export const metadata = createPageMetadata({
  title: "Webhook Testing Tools Compared: Features & Pricing (2026)",
  description:
    "One feature checklist for webhooks.cc, Webhook.site, RequestBin, Beeceptor, Hookdeck, ngrok, Svix, Stripe CLI, Smee.io and LocalTunnel: history, replay, CLI, CI SDK and MCP.",
  path: "/compare",
  keywords: [
    "webhook testing tool comparison",
    "webhook testing alternatives",
    "webhook.site alternative",
    "ngrok alternative",
    "ngrok vs hookdeck",
    "svix alternative",
    "stripe cli alternative",
    "requestbin alternative",
    "beeceptor alternative",
    "hookdeck alternative",
    "smee.io alternative",
    "localtunnel alternative",
    "webhook inspection tools",
  ],
});

const COMPARISONS = [
  {
    href: "/compare/webhook-site",
    title: "webhooks.cc vs Webhook.site",
    summary:
      "Both capture webhooks and email. webhooks.cc adds an SDK for CI assertions, MCP for AI agents, email forwarded as signed JSON, and every individual feature on both tiers, with Teams billed separately at $12/seat/mo.",
  },
  {
    href: "/compare/ngrok",
    title: "webhooks.cc vs ngrok",
    summary:
      "ngrok is a general-purpose tunnel. webhooks.cc is a webhook testing platform with capture, replay, SDK, and MCP built in.",
  },
  {
    href: "/compare/hookdeck",
    title: "webhooks.cc vs Hookdeck",
    summary:
      "Hookdeck is production webhook infrastructure (retries, routing). webhooks.cc is a development testing tool. They complement each other.",
  },
  {
    href: "/compare/svix",
    title: "webhooks.cc vs Svix",
    summary:
      "Svix is production webhook infrastructure (outbound delivery, Svix Ingest, and Svix Play). webhooks.cc tests inbound webhooks and emails across 32+ signed providers with SDK assertions and MCP.",
  },
  {
    href: "/compare/stripe-cli",
    title: "webhooks.cc vs Stripe CLI",
    summary:
      "Stripe CLI forwards Stripe events to localhost. webhooks.cc brings that CLI tunnel workflow, persistent history, and CI SDK signing to 32+ webhook providers and inbound email.",
  },
  {
    href: "/compare/requestbin",
    title: "webhooks.cc vs RequestBin (Pipedream)",
    summary:
      "RequestBin evolved into a workflow automation platform. webhooks.cc stays focused on webhook testing and developer tooling.",
  },
  {
    href: "/compare/beeceptor",
    title: "webhooks.cc vs Beeceptor",
    summary:
      "Beeceptor excels at API mocking. webhooks.cc excels at capturing and testing real webhook payloads with SDK and MCP.",
  },
  {
    href: "/compare/smee",
    title: "webhooks.cc vs Smee.io",
    summary:
      "Smee.io is a minimal webhook proxy by GitHub. webhooks.cc adds persistent history, replay, SDK assertions, and MCP on top of forwarding.",
  },
  {
    href: "/compare/localtunnel",
    title: "webhooks.cc vs LocalTunnel",
    summary:
      "LocalTunnel is a free, simple tunnel. webhooks.cc tunnels too, and also captures, inspects, replays, and tests every request.",
  },
] as const;

const TOOLS = [
  { name: "webhooks.cc", href: null },
  { name: "Webhook.site", href: "/compare/webhook-site" },
  { name: "RequestBin", href: "/compare/requestbin" },
  { name: "Beeceptor", href: "/compare/beeceptor" },
  { name: "Hookdeck", href: "/compare/hookdeck" },
  { name: "ngrok", href: "/compare/ngrok" },
  { name: "Svix", href: "/compare/svix" },
  { name: "Stripe CLI", href: "/compare/stripe-cli" },
  { name: "Smee.io", href: "/compare/smee" },
  { name: "LocalTunnel", href: "/compare/localtunnel" },
] as const;

// One row per feature, one cell per tool in TOOLS order. Every cell restates
// the matching row of that tool's compare page; change them together.
const MATRIX: readonly (readonly [string, ...string[]])[] = [
  [
    "Stored request history",
    "Yes",
    "Yes",
    "As workflow triggers",
    "Request log",
    "Event log",
    "Local inspector while running",
    "Svix Play / Cloud logs",
    "In Stripe Dashboard only",
    "No",
    "No",
  ],
  [
    "Request replay",
    "To any URL",
    "Yes",
    "Re-trigger workflow",
    "No",
    "Redelivery",
    "To local upstream",
    "Resend deliveries",
    "stripe events resend",
    "No",
    "No",
  ],
  [
    "Mock responses",
    "Yes",
    "Paid",
    "Via workflow code",
    "Yes, rule-based",
    "No",
    "No",
    "Static in Play",
    "No",
    "No",
    "No",
  ],
  [
    "CLI tunnel to localhost",
    "Yes",
    "Yes",
    "No",
    "No",
    "Yes",
    "Yes",
    "Yes (Play)",
    "Stripe only",
    "Yes",
    "Yes",
  ],
  ["SDK assertions in CI", "Yes", "No", "No", "No", "No", "No", "No", "No", "No", "No"],
  [
    "MCP server",
    "Yes",
    "No",
    "No",
    "No",
    "Operations only",
    "No",
    "App Portal MCP",
    "Stripe API ops",
    "No",
    "No",
  ],
  ["Open source", "Yes", "No", "No", "No", "Partially", "Agent only", "Yes", "Yes", "Yes", "Yes"],
  [
    "Team plan",
    "$12/seat/mo, pooled quota",
    "Enterprise, from $69/mo",
    "All plans, unlimited members",
    "Team+ $25/mo",
    "Team+ $39/mo",
    "$20/mo incl. 3 seats",
    "Cloud plans, from $20/mo",
    "Via Stripe account",
    "None",
    "None",
  ],
];

const FAQ_ITEMS: FAQItem[] = [
  {
    question:
      "What are the best alternatives to Webhook.site for capturing and inspecting webhook payloads?",
    answer:
      "webhooks.cc works the same way (an instant URL and a live page of every request) and adds a CLI tunnel to localhost, a TypeScript SDK for assertions in CI and an MCP server, with every individual feature on the free plan. Beeceptor suits API mocking, RequestBin now lives inside Pipedream's workflow platform, and Hookdeck is production delivery infrastructure.",
  },
  {
    question: "Which webhook tools have a CLI tunnel to localhost and a free tier?",
    answer:
      "webhooks.cc (whk tunnel, free plan with 50 requests a day and every feature), Hookdeck (hookdeck listen, free tier with limited events), ngrok (free tier), Stripe CLI (stripe listen, for Stripe events only), and the free, open-source Smee.io and LocalTunnel. Only webhooks.cc and Hookdeck also keep a stored cross-provider history of what arrived.",
  },
  {
    question: "What should I compare when choosing a paid webhook testing tool?",
    answer:
      "How long requests are kept, who can read them (anyone with the URL, or signed-in members only), how team seats are priced, replay to any URL, search across bodies and headers, a CLI tunnel to localhost, assertions in CI, signature verification for your providers, email capture if your app sends mail, and whether you can self-host.",
  },
  {
    question: "Which webhook service has searchable logs and one-click replay?",
    answer:
      "webhooks.cc stores every request, searches across path, body and headers, and replays any request to any URL from the dashboard, CLI or SDK. Webhook.site and Hookdeck also replay; ngrok replays from its local inspector to the same upstream while the agent runs.",
  },
  {
    question: "Which webhook testing tools support teams?",
    answer:
      "webhooks.cc Teams shares endpoints with signed-in members at $12 per seat per month, with 100,000 requests per seat pooled and 31-day retention. Webhook.site offers team features on Enterprise, Beeceptor and Hookdeck on their Team+ plans, and ngrok includes three seats on its paid plan. Smee.io and LocalTunnel have no accounts.",
  },
];

export default function CompareIndexPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />
      <div className="max-w-4xl mx-auto">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">Updated October 2026</p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">Webhook testing tools compared</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Honest, developer-focused comparisons against popular webhook testing alternatives. The
          checklist below puts them side by side; each page covers features, tradeoffs, and when to
          choose each tool.
        </p>

        <h2 className="text-2xl font-bold mb-4">Feature checklist</h2>
        <div className="ui-code overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-strong border-line">
                <th scope="col" className="text-left py-2.5 pr-4 font-bold">
                  Feature
                </th>
                {TOOLS.map((tool) => (
                  <th
                    key={tool.name}
                    scope="col"
                    className="text-left py-2.5 pr-4 font-bold whitespace-nowrap"
                  >
                    {tool.href ? (
                      <Link href={tool.href} className="hover:text-primary transition-colors">
                        {tool.name}
                      </Link>
                    ) : (
                      tool.name
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MATRIX.map(([feature, ...cells]) => (
                <tr key={feature} className="border-b border-foreground/20 last:border-0">
                  <th scope="row" className="text-left py-2.5 pr-4 font-medium whitespace-nowrap">
                    {feature}
                  </th>
                  {cells.map((cell, i) => (
                    <td key={TOOLS[i].name} className="py-2.5 pr-4">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted-foreground mb-10">
          Other tools as listed on their own sites when we compared; check pricing before you buy.
          Sharing with a team?{" "}
          <Link href="/for-teams" className="text-primary font-bold hover:underline">
            Webhook testing for teams
          </Link>
          .
        </p>

        <h2 className="text-2xl font-bold mb-4">Side-by-side pages</h2>

        <div className="space-y-4">
          {COMPARISONS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="ui-card ui-card-static block transition-colors hover:bg-muted"
            >
              <h2 className="text-xl font-bold mb-2">{item.title}</h2>
              <p className="text-muted-foreground">{item.summary}</p>
            </Link>
          ))}
        </div>

        <h2 className="text-2xl font-bold mt-12 mb-4">Frequently asked questions</h2>
        <FAQAccordion items={FAQ_ITEMS} />
      </div>
    </main>
  );
}
