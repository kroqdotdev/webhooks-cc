import Link from "next/link";
import {
  ArrowRight,
  Bug,
  Check,
  FlaskConical,
  Lock,
  Radio,
  Server,
  Terminal,
  UserPlus,
} from "lucide-react";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema, howToSchema, type FAQItem } from "@/lib/schemas";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { TeamsCTA } from "@/components/landing/teams-cta";

const PATH = "/for-teams";

export const metadata = createPageMetadata({
  title: "Webhook Testing for Teams: Shared Endpoints, $12/seat",
  description:
    "Share webhook endpoints with your team. Everyone sees the same requests live, with 31-day retention, sign-in-only access, replay and a pooled quota of 100,000 requests per seat.",
  path: PATH,
  keywords: [
    "webhook testing for teams",
    "shared webhook endpoint",
    "team webhook inspector",
    "webhook testing staging environment",
    "webhook debugging team",
    "requestbin for teams",
    "webhook.site for teams",
    "shared webhook url",
  ],
});

const USE_CASES = [
  {
    icon: Server,
    title: "One staging endpoint for everyone",
    text: "Point Stripe test mode, GitHub or Shopify at one shared URL. Every developer sees each delivery as it arrives, instead of one person's ngrok tunnel catching it.",
  },
  {
    icon: FlaskConical,
    title: "QA sees what their click triggered",
    text: "A tester places an order and finds the webhook it fired in the shared list, with headers, body and signature check, without asking a developer to dig through logs.",
  },
  {
    icon: Bug,
    title: "Debug a delivery together",
    text: "Capture the payload that broke production on a shared endpoint, link it in the incident channel, and replay it against a fix on anyone's machine.",
  },
  {
    icon: Terminal,
    title: "Each developer forwards to their own localhost",
    text: "whk tunnel 3000 --endpoint <shared-slug> streams the team's endpoint to a local handler. Several people can listen to the same endpoint at once.",
  },
];

const CHECKLIST = [
  "Shared endpoints visible to team members only, after sign-in",
  "31-day retention for every team-billed request, on any personal plan (90 with Team Business)",
  "Live updates in the dashboard and over SSE for every member",
  "Replay any captured request to any URL",
  "Search across path, body and headers",
  "Mock responses members can edit; signing and forwarding stay with the endpoint owner",
  "Email capture: each shared endpoint has its own address",
  "CLI, TypeScript SDK and MCP server see shared endpoints like your own",
  "Owner-only delete, sharing, invites and billing",
  "Pooled quota: 100,000 requests per seat per 30 days",
  "Team Business add-on: +150,000 requests, 2,000 parsed attachment pages a month, 50 layouts per endpoint, a custom inbound domain and file drops",
];

const PERMISSIONS: readonly (readonly [string, boolean, boolean])[] = [
  ["View requests", true, true],
  ["Edit mock response", true, true],
  ["Rename endpoint", true, true],
  ["Delete endpoint", true, false],
  ["Share or unshare endpoints", true, false],
  ["Invite and remove members", true, false],
  ["Manage billing", true, false],
];

const PRICE_EXAMPLES = [
  { seats: 3, price: 36, requests: "300,000" },
  { seats: 5, price: 60, requests: "500,000" },
  { seats: 10, price: 120, requests: "1,000,000" },
];

// Team pricing as each compare page lists it; keep the two in sync.
const TEAM_PRICING = [
  { tool: "webhooks.cc", team: "$12/seat/mo, pooled quota", href: null },
  { tool: "Webhook.site", team: "Enterprise only, from $69/mo", href: "/compare/webhook-site" },
  { tool: "Beeceptor", team: "Team+ ($25/mo), unlimited members", href: "/compare/beeceptor" },
  { tool: "Hookdeck", team: "Team+ ($39/mo), unlimited seats", href: "/compare/hookdeck" },
  { tool: "ngrok", team: "$20/mo incl. 3 seats, then $5/seat", href: "/compare/ngrok" },
  { tool: "Smee.io", team: "None (anonymous channels)", href: "/compare/smee" },
];

const STEPS = [
  {
    name: "Create a team",
    text: "Open Teams from the avatar menu and pick a name. Any account can create one, whatever its personal plan; you become the owner.",
  },
  {
    name: "Choose seats and subscribe",
    text: "Each seat is one member, the owner included, and adds 100,000 requests per 30 days to the team's pool. $12 per seat per month.",
  },
  {
    name: "Invite your team",
    text: "Invite anyone by email. People without an account find the invite waiting after they sign up with that address.",
  },
  {
    name: "Share endpoints",
    text: "In an endpoint's Settings tab, share it with the team. Members see it under Shared with me, and its requests bill to the team.",
  },
];

const FAQ_ITEMS: FAQItem[] = [
  {
    question: "Can my team share one webhook URL and see the same requests?",
    answer:
      "Yes. Share an endpoint with your team and every member sees its requests live in the dashboard, with headers, body, query and signature checks. Members can also stream it from the CLI, SDK or MCP server and forward it to their own localhost.",
  },
  {
    question: "How much does webhooks.cc cost for a team?",
    answer:
      "$12 per seat per month, billed per team on a 30-day period. Each seat is one member, the owner included, and adds 100,000 requests per 30 days to a pool the whole team shares. A team of 5 pays $60 a month for 500,000 requests. The optional Team Business add-on, $49 a month, adds 150,000 requests, 2,000 parsed attachment pages a month, a custom inbound domain, file drops and 90-day retention.",
  },
  {
    question: "Do team members need a paid plan?",
    answer:
      "No. Members can be on the Free plan. Requests on endpoints shared with an active team draw from the team's pool and keep 31-day retention (90 days with Team Business), whatever plan the endpoint owner is on.",
  },
  {
    question: "Which webhook testing tools support longer retention and access control for teams?",
    answer:
      "On webhooks.cc, team-billed requests are kept for 31 days, or 90 with the Team Business add-on, and shared endpoints can only be read by signed-in team members. Guest URLs on any tool, webhooks.cc's included, are readable by anyone who knows the address, so a team should capture on shared account endpoints instead.",
  },
  {
    question: "What happens when the team's quota runs out?",
    answer:
      "The receiver answers 429 Too Many Requests with a Retry-After header pointing at the team's period reset, so well-behaved senders retry later. Add seats to raise the pool at once; the added seats are charged their share of the current period.",
  },
  {
    question: "Is there a free trial for Teams?",
    answer:
      "Every webhooks.cc feature works on the free personal plan, so you can try capture, replay, the CLI and the SDK on your own first. A team itself starts working once it has an active subscription; until then it is kept but suspended.",
  },
  {
    question: "Can we cancel or change the number of seats?",
    answer:
      "Yes. Added seats are charged right away for the rest of the period. Removed seats stay until the renewal, which then bills the lower count. Canceling keeps the team active until the period ends; nothing is deleted.",
  },
];

export default function ForTeamsPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Teams", path: PATH },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />
      <JsonLd
        data={howToSchema({
          name: "How to share webhook endpoints with your team",
          description:
            "Create a team on webhooks.cc, subscribe seats, invite members and share endpoints so everyone sees the same webhooks.",
          steps: STEPS,
          totalTime: "PT5M",
        })}
      />

      <div className="max-w-4xl mx-auto">
        <div className="mb-12">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">
            Webhook testing for teams
          </h1>
          <p className="text-xl text-muted-foreground mb-6">
            Share webhook endpoints with your team. Everyone sees the same requests the moment they
            arrive, replays them against their own code, and stops pasting payloads into chat. $12
            per seat per month, with every seat adding 100,000 requests to one shared pool.
          </p>
          <TeamsCTA />
          <p className="text-sm text-muted-foreground mt-4">
            Any account can create a team. Read the{" "}
            <Link href="/docs/teams" className="text-primary font-bold hover:underline">
              Teams docs
            </Link>{" "}
            for every detail.
          </p>
        </div>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">What teams use it for</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {USE_CASES.map((item) => (
              <div key={item.title} className="ui-card ui-card-static">
                <item.icon className="h-5 w-5 text-primary mb-3" aria-hidden="true" />
                <h3 className="font-bold mb-1.5">{item.title}</h3>
                <p className="text-sm text-muted-foreground">{item.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Feature checklist</h2>
          <ul className="grid sm:grid-cols-2 gap-3">
            {CHECKLIST.map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Check className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <span className="text-sm">{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">Set up a team in four steps</h2>
          <ol className="space-y-4">
            {STEPS.map((step, i) => (
              <li key={step.name} className="flex gap-4">
                <span className="w-9 h-9 border-strong border-line rounded-md bg-primary text-primary-foreground flex items-center justify-center font-bold shrink-0 shadow-raised-sm">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-bold mb-0.5">{step.name}</h3>
                  <p className="text-muted-foreground text-sm">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">Who can do what</h2>
          <div className="ui-card ui-card-static overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-strong border-line">
                  <th scope="col" className="text-left py-2 pr-6 font-bold">
                    Action
                  </th>
                  <th scope="col" className="text-left py-2 pr-6 font-bold">
                    Owner
                  </th>
                  <th scope="col" className="text-left py-2 font-bold">
                    Member
                  </th>
                </tr>
              </thead>
              <tbody>
                {PERMISSIONS.map(([action, owner, member]) => (
                  <tr key={action} className="border-b border-foreground/10 last:border-0">
                    <td className="py-2 pr-6">{action}</td>
                    <td className="py-2 pr-6">{owner ? "Yes" : "No"}</td>
                    <td className="py-2">{member ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground mt-3 flex items-start gap-2">
            <Lock className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            Shared endpoints are only readable by signed-in members. Members cannot delete an
            endpoint or clear its requests, and its signing, forwarding, email and notification
            settings stay with the person who owns it.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">Pricing</h2>
          <p className="text-muted-foreground mb-6">
            Billed per team, not per account, on a 30-day period that starts when the team
            subscribes. Prices include VAT where it applies.
          </p>
          <div className="grid sm:grid-cols-3 gap-4 mb-6">
            {PRICE_EXAMPLES.map((example) => (
              <div key={example.seats} className="ui-card ui-card-static text-center">
                <p className="text-sm text-muted-foreground mb-1">{example.seats} seats</p>
                <p className="text-3xl font-bold mb-1">${example.price}/mo</p>
                <p className="text-sm text-muted-foreground">
                  {example.requests} requests per 30 days
                </p>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground mb-8">
            Need more? The Team Business add-on is $49 a month on the team&apos;s subscription
            (monthly only): 150,000 more requests in the pool, 2,000 pooled parsed attachment pages
            a month with page blocks and page overage, up to 50 layouts per endpoint on shared
            endpoints, 500 AI assists, one custom inbound domain, file drops, and 90-day retention
            for team-billed requests. Members&apos; personal endpoints follow their own plan.{" "}
            <Link
              href="/docs/plans-limits#teams-and-shared-endpoints"
              className="text-primary font-bold hover:underline"
            >
              Plans and limits
            </Link>
          </p>
          <h3 className="text-lg font-bold mb-3">Team plans compared</h3>
          <div className="ui-card ui-card-static overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {TEAM_PRICING.map((row) => (
                  <tr key={row.tool} className="border-b border-foreground/10 last:border-0">
                    <th scope="row" className="text-left py-2 pr-6 font-bold whitespace-nowrap">
                      {row.href ? (
                        <Link href={row.href} className="hover:text-primary transition-colors">
                          {row.tool}
                        </Link>
                      ) : (
                        row.tool
                      )}
                    </th>
                    <td className="py-2">{row.team}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground mt-3">
            Other tools&apos; prices as listed on their sites when we compared; check them before
            you buy.{" "}
            <Link href="/compare" className="text-primary font-bold hover:underline">
              All comparisons
            </Link>
          </p>
        </section>

        <section className="mb-12">
          <div className="ui-card ui-card-static">
            <Radio className="h-5 w-5 text-primary mb-3" aria-hidden="true" />
            <h2 className="text-xl md:text-2xl font-bold mb-2">Shared endpoints from the CLI</h2>
            <p className="text-muted-foreground mb-4">
              An API key carries the team access of its account, so shared endpoints work like your
              own in the CLI, the SDK and the MCP server.
            </p>
            <div className="ui-code overflow-x-auto">
              <pre className="text-sm">
                <code>
                  whk list --team Payments{"\n"}
                  whk listen &lt;shared-slug&gt;{"\n"}
                  whk tunnel 3000 --endpoint &lt;shared-slug&gt;{"\n"}
                  whk teams share my-stripe --team Payments
                </code>
              </pre>
            </div>
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Teams questions</h2>
          <FAQAccordion items={FAQ_ITEMS} />
        </section>

        <div className="ui-card bg-foreground text-background text-center py-12">
          <UserPlus className="h-8 w-8 mx-auto mb-4" aria-hidden="true" />
          <h2 className="text-2xl md:text-3xl font-bold mb-3">Bring your team in</h2>
          <p className="opacity-80 mb-6 max-w-md mx-auto">
            Create a team, pick your seats, and share your first endpoint.
          </p>
          <div className="flex justify-center text-foreground">
            <TeamsCTA className="ui-btn-primary inline-block" />
          </div>
          <p className="text-sm opacity-80 mt-6">
            <Link href="/docs/teams" className="font-bold underline hover:no-underline">
              How Teams works
              <ArrowRight className="inline-block ml-1 h-4 w-4" />
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
