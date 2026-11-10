import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema, type FAQItem } from "@/lib/schemas";
import { FAQAccordion } from "@/components/landing/faq-accordion";

export const metadata = createPageMetadata({
  title: "Webhook Testing Tools Compared: Features & Pricing (2026)",
  description:
    "Feature checklists for webhooks.cc against Webhook.site, RequestBin, Beeceptor, Hookdeck, ngrok, Svix, Stripe CLI, Smee.io and LocalTunnel, and against Mailtrap, Mailosaur and MailSlurp for email testing.",
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
    "email testing tools",
    "mailtrap alternative",
    "mailosaur alternative",
    "mailslurp alternative",
  ],
});

const COMPARISONS = [
  {
    href: "/compare/webhook-site",
    title: "webhooks.cc vs Webhook.site",
    summary:
      "Both capture webhooks and email. webhooks.cc adds SDKs for CI assertions in TypeScript, Python and Go, MCP for AI agents, forwarding to up to 10 destinations with retries, email parsing, and every Pro feature on the free plan.",
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
      "Hookdeck is a production event gateway. webhooks.cc is built for testing, and still forwards what it captures to up to 10 destinations with filters, throttling and retries. They complement each other.",
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
      "RequestBin became part of Pipedream Workflows, which takes no new signups and shuts down on March 31, 2027. webhooks.cc stays focused on webhook and email testing, and sends what arrives to Slack, Discord, Google Sheets, Zapier or Make without workflow code.",
  },
  {
    href: "/compare/beeceptor",
    title: "webhooks.cc vs Beeceptor",
    summary:
      "Beeceptor excels at API mocking. webhooks.cc excels at capturing and testing real webhook payloads, with rule-based mock responses, SDKs and MCP.",
  },
  {
    href: "/compare/smee",
    title: "webhooks.cc vs Smee.io",
    summary:
      "Smee.io is a minimal webhook proxy from the Probot team. webhooks.cc adds persistent history, replay, SDK assertions, email capture, and MCP on top of forwarding.",
  },
  {
    href: "/compare/localtunnel",
    title: "webhooks.cc vs LocalTunnel",
    summary:
      "LocalTunnel is a free, simple tunnel that has had no release since 2021. webhooks.cc tunnels too, and also captures, inspects, replays, and tests every request.",
  },
] as const;

const EMAIL_COMPARISONS = [
  {
    href: "/compare/mailtrap",
    title: "webhooks.cc vs Mailtrap",
    summary:
      "Mailtrap Email Sandbox is a fake SMTP server with HTML and spam checks. webhooks.cc gives tests a real address, waits for the email in the SDK and picks out the code or the link, with 50 emails a day on the free plan.",
  },
  {
    href: "/compare/mailosaur",
    title: "webhooks.cc vs Mailosaur",
    summary:
      "Both give tests real addresses, a wait and code extraction. Mailosaur adds SMS numbers, real-device previews and an authenticator on plans from $20 a month; webhooks.cc has a free plan, Pro at $8 and webhooks on the same endpoint.",
  },
  {
    href: "/compare/mailslurp",
    title: "webhooks.cc vs MailSlurp",
    summary:
      "MailSlurp is an email and SMS API whose inboxes send as well as receive. webhooks.cc only receives: one endpoint, a tag per test run, no inboxes to create, and 100,000 emails or webhooks a month for $8.",
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
    "Request log, Team and up",
    "Event log",
    "Local inspector while running",
    "Svix Play / Cloud logs",
    "In Stripe Dashboard only",
    "Browser only",
    "No",
  ],
  [
    "Request replay",
    "To any URL",
    "Yes",
    "Re-trigger workflow",
    "Not documented",
    "Redelivery",
    "To local upstream",
    "Resend deliveries",
    "stripe events resend",
    "To the channel's clients",
    "No",
  ],
  [
    "Mock responses",
    "Yes, rule-based",
    "Static free, dynamic paid",
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
    "Yes",
    "Yes",
    "Yes",
    "Yes (Play)",
    "Stripe only",
    "Yes",
    "Yes",
  ],
  [
    "SDK assertions in CI",
    "TypeScript, Python, Go",
    "No",
    "No",
    "No",
    "No",
    "No",
    "No",
    "No",
    "No",
    "No",
  ],
  [
    "MCP server",
    "Remote (OAuth) or local",
    "No",
    "App integrations only",
    "Mock rules and history",
    "Gateway operations",
    "Account operations",
    "App Portal, for end users",
    "Stripe API ops",
    "No",
    "No",
  ],
  [
    "Inbound email",
    "{slug}@mailhooks.cc or your own domain",
    "Every URL",
    "Email trigger",
    "No",
    "Via an email provider",
    "No",
    "No",
    "No",
    "No",
    "No",
  ],
  [
    "Open source",
    "Yes",
    "MIT edition",
    "No",
    "No",
    "CLI, Outpost",
    "Agent SDKs",
    "Yes",
    "Yes",
    "Yes",
    "Yes",
  ],
  [
    "Team plan",
    "From $12/seat/mo, pooled quota",
    "Enterprise, from $69/mo",
    "All plans, unlimited members",
    "Team $25/mo",
    "Team from $39/mo",
    "$20/mo incl. 3 seats",
    "Cloud plans, from $20/mo",
    "Via Stripe account",
    "None",
    "None",
  ],
];

const EMAIL_TOOLS = [
  { name: "webhooks.cc", href: null },
  { name: "Mailtrap", href: "/compare/mailtrap" },
  { name: "Mailosaur", href: "/compare/mailosaur" },
  { name: "MailSlurp", href: "/compare/mailslurp" },
] as const;

// The same rule as MATRIX, for the email testing tools in EMAIL_TOOLS order.
const EMAIL_MATRIX: readonly (readonly [string, ...string[]])[] = [
  [
    "How mail gets in",
    "Real address per endpoint",
    "Fake SMTP server; address from Basic",
    "Real addresses, or SMTP",
    "Inboxes created by API",
  ],
  [
    "Free plan",
    "50 emails a day",
    "50 test emails a month",
    "None; 14-day trial",
    "250 received a month",
  ],
  ["Paid plans from", "$8/mo", "$17/mo", "$20/mo, billed annually", "$19.99/mo"],
  ["Codes and links picked out", "Yes", "Not documented", "Yes", "Yes"],
  ["Wait for an email in a test", "Yes", "Not documented", "Yes", "Yes"],
  [
    "SDKs",
    "TypeScript, Python, Go",
    "Node.js, PHP, Ruby, Python, Java, .NET, Elixir, Go",
    "Node.js, Python, Java, .NET, Ruby, PHP, Go",
    "JavaScript, Python, Java, C#, PHP, Ruby, Go and more",
  ],
  ["CLI", "Yes", "Yes", "Not documented", "No maintained CLI"],
  ["MCP server", "Remote (OAuth) or local", "Local", "Core and up", "Hosted"],
  [
    "Webhook when an email arrives",
    "Yes, with retries",
    "Not for sandboxes",
    "Not documented",
    "Yes, with retries",
  ],
  [
    "Email client screenshots",
    "No",
    "On request, paid plans",
    "Add-on on Core",
    "1 to 200 a month by plan",
  ],
  ["Webhook capture on the same endpoint", "Yes", "No", "No", "No"],
  ["Open source", "Yes", "SDKs and Mailtrap Local", "Client libraries on GitHub", "SDKs on GitHub"],
];

const FAQ_ITEMS: FAQItem[] = [
  {
    question: "Which email testing tools have a free plan?",
    answer:
      "webhooks.cc takes 50 emails a day on its free plan, with real addresses, the SDKs, the CLI and the MCP server included. Mailtrap's free Email Sandbox takes 50 test emails a month in one sandbox, and MailSlurp's free plan receives 250 emails a month in temporary inboxes. Mailosaur has a 14-day trial and no free plan. Figures from each tool's pricing page in November 2026.",
  },
  {
    question: "Which webhook testing tools also capture email?",
    answer:
      "webhooks.cc gives every endpoint on an account, free included, an address at {slug}@mailhooks.cc (and your own domain on Business): each email shows its codes, links and SPF, DKIM and DMARC results, layouts read fields, line items and attachments out of it, and destinations send it on as signed JSON, to Google Sheets, Slack, Zapier or Make. mailhooks.cc is the mail-first front door to the same accounts. Webhook.site gives every URL an address, and acting on email there takes its paid Custom Actions. Pipedream's email trigger closes with its Workflows in March 2027, Hookdeck needs an email provider in front of it, and the other tools here handle HTTP only.",
  },
  {
    question:
      "What are the best alternatives to Webhook.site for capturing and inspecting webhook payloads?",
    answer:
      "webhooks.cc works the same way (an instant URL and a live page of every request, and an email address for each account endpoint) and adds SDKs for assertions in CI in TypeScript, Python and Go, forwarding to up to 10 destinations, email parsing and an MCP server, with every Pro feature on the free plan. Beeceptor suits API mocking and Hookdeck is production delivery infrastructure. RequestBin's home, Pipedream Workflows, takes no new signups and shuts down in March 2027.",
  },
  {
    question: "Which webhook tools have a CLI tunnel to localhost and a free tier?",
    answer:
      "webhooks.cc (whk tunnel, free plan with 50 requests a day and every Pro feature), Webhook.site (whcli forward), Beeceptor (beeceptor-cli, with tunnels that end with the session on its free plan), Hookdeck (hookdeck listen, free for one user), ngrok (free tier), Stripe CLI (stripe listen, for Stripe events only), and the free, open-source Smee.io and LocalTunnel. Only webhooks.cc and Hookdeck also keep a stored cross-provider history of what arrived.",
  },
  {
    question: "What should I compare when choosing a paid webhook testing tool?",
    answer:
      "How long requests are kept, who can read them (anyone with the URL, or signed-in members only), how team seats are priced, replay to any URL, search across bodies and headers, a CLI tunnel to localhost, assertions in CI, signature verification for your providers, and email capture if your app sends mail.",
  },
  {
    question: "Which webhook service has searchable logs and one-click replay?",
    answer:
      "webhooks.cc stores every request, searches across path, body and headers, and replays any request to any URL from the dashboard, CLI or SDK. Webhook.site and Hookdeck also replay; ngrok replays from its local inspector to the same upstream while the agent runs.",
  },
  {
    question: "Which webhook testing tools support teams?",
    answer:
      "webhooks.cc Teams shares endpoints with signed-in members at $12 per seat per month, with 100,000 requests per seat pooled and 31-day retention; Team Business ($35 per seat) gives each seat Business's limits and 90-day retention. Webhook.site offers team features on Enterprise, Beeceptor and Hookdeck on their Team plans, and ngrok includes three seats on its paid plan. Smee.io and LocalTunnel have no accounts.",
  },
];

function Checklist({
  tools,
  matrix,
}: {
  tools: readonly { name: string; href: string | null }[];
  matrix: readonly (readonly [string, ...string[]])[];
}) {
  return (
    <div className="ui-code overflow-x-auto mb-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-strong border-line">
            <th scope="col" className="text-left py-2.5 pr-4 font-bold">
              Feature
            </th>
            {tools.map((tool) => (
              <th
                key={tool.name}
                scope="col"
                className="text-left py-2.5 pr-4 font-bold whitespace-nowrap"
              >
                {tool.href ? (
                  <Link href={tool.href} className="hover:text-primary-ink transition-colors">
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
          {matrix.map(([feature, ...cells]) => (
            <tr key={feature} className="border-b border-foreground/20 last:border-0">
              <th scope="row" className="text-left py-2.5 pr-4 font-medium whitespace-nowrap">
                {feature}
              </th>
              {cells.map((cell, i) => (
                <td key={tools[i].name} className="py-2.5 pr-4">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CompareIndexPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />
      <div className="max-w-4xl mx-auto">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">Updated November 2026</p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">Webhook testing tools compared</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Honest, developer-focused comparisons against popular webhook testing alternatives, and
          against the{" "}
          <a href="#email-testing-tools" className="text-primary-ink font-bold hover:underline">
            email testing tools
          </a>{" "}
          developers weigh for signup and login tests. The checklists below put them side by side;
          each page covers features, tradeoffs, and when to choose each tool.
        </p>

        <h2 className="text-2xl font-bold mb-4">Feature checklist</h2>
        <Checklist tools={TOOLS} matrix={MATRIX} />
        <p className="text-sm text-muted-foreground mb-10">
          Other tools as listed on their own sites when we compared in November 2026; check pricing
          before you buy. RequestBin lives on Pipedream Workflows, which takes no new signups and
          shuts down on March 31, 2027. Sharing with a team?{" "}
          <Link href="/for-teams" className="text-primary-ink font-bold hover:underline">
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

        <h2 id="email-testing-tools" className="text-2xl font-bold mt-12 mb-4 scroll-mt-24">
          Email testing tools compared
        </h2>
        <p className="text-muted-foreground mb-4">
          Every endpoint on a webhooks.cc account also receives email, so the same tool covers{" "}
          <Link href="/email-testing" className="text-primary-ink font-bold hover:underline">
            email testing
          </Link>
          : signup, magic link and password reset emails in Playwright, Cypress and CI. This is how
          it compares with the tools built for that alone.
        </p>
        <Checklist tools={EMAIL_TOOLS} matrix={EMAIL_MATRIX} />
        <p className="text-sm text-muted-foreground mb-6">
          Other tools as listed on their own sites when we compared in November 2026; &quot;not
          documented&quot; means we did not find it there.
        </p>
        <div className="space-y-4">
          {EMAIL_COMPARISONS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="ui-card ui-card-static block transition-colors hover:bg-muted"
            >
              <h3 className="text-xl font-bold mb-2">{item.title}</h3>
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
