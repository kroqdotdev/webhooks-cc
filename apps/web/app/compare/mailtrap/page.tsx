import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { ComparisonCTA } from "@/components/compare/comparison-cta";
import { InlineCode } from "@/components/ui/code";
import { Card } from "@/components/ui/card";
import { PairLinks } from "@/components/compare/pair-links";

const FAQ_ITEMS = [
  {
    question: "What is a good Mailtrap alternative for automated email tests?",
    answer:
      "webhooks.cc suits end-to-end tests that need the code or the link inside a real email. Every endpoint on an account has a real address ({slug}@mailhooks.cc, with a +tag per test run), the SDKs for TypeScript, Python and Go wait for the email and return its one-time code or link, and the free plan takes 50 emails a day. Mailtrap Email Sandbox is the better fit when you want a fake SMTP server in front of staging, an HTML check against email clients, or forwarding of test mail to real inboxes.",
  },
  {
    question: "What is the difference between webhooks.cc and Mailtrap Email Sandbox?",
    answer:
      "How the mail gets in, and what you do with it. Mailtrap Email Sandbox is a fake SMTP server: you point your app's SMTP settings (or Mailtrap's send API) at a sandbox and it traps what the app sends. webhooks.cc gives you a real address, so your app sends through its normal provider (Resend, Postmark, SES, plain SMTP) and the email is checked as it really arrived, with SPF, DKIM and DMARC results. webhooks.cc then picks out codes and links for tests; Mailtrap analyses the HTML and the spam score.",
  },
  {
    question: "How do the free plans compare?",
    answer:
      "Mailtrap's free Email Sandbox plan lists 50 test emails a month, one sandbox that keeps 10 emails, and one user, without a sandbox email address. webhooks.cc's free plan takes 50 requests a day (an email counts as one), keeps them for 7 days and includes every Pro feature: real addresses, the SDKs, the CLI and the MCP server. Mailtrap's figures are from its pricing page in November 2026.",
  },
  {
    question: "Does webhooks.cc have a fake SMTP server like Mailtrap?",
    answer:
      "No. webhooks.cc has no SMTP credentials to paste into your app. It receives mail at real addresses instead, so nothing in the app's mail settings changes for a test. If you need to trap everything a staging environment sends, whoever it is addressed to, Mailtrap Email Sandbox does that and webhooks.cc does not.",
  },
  {
    question: "Can I read one-time codes and magic links from an email in Playwright or Cypress?",
    answer:
      "With webhooks.cc, yes: client.emails.waitFor(slug, { tag }) waits for the email and extractCode(email) or extractLink(email) returns the code or the link, and the REST API returns the same with extracts=true. Mailtrap's docs describe a REST API for listing and reading sandbox messages; we found no wait helper or code extraction there, so a test polls and parses the body itself.",
  },
  {
    question: "Does Mailtrap or webhooks.cc send a webhook when an email arrives?",
    answer:
      "webhooks.cc does on every plan: each endpoint sends what it receives to up to 10 destinations as signed JSON with retries, or to Slack, Discord, Google Sheets, Zapier or Make. Mailtrap documents webhooks for its sending, inbound, campaign, reputation and audit log products, not for Email Sandbox messages.",
  },
];

const ROWS = [
  [
    "Primary focus",
    "Capturing real email and webhooks for tests",
    "Email Sandbox (fake SMTP), next to its sending and marketing products",
  ],
  [
    "How mail gets in",
    "A real address per endpoint ({slug}@mailhooks.cc), from any sender",
    "Fake SMTP server or send API; a sandbox email address from Basic",
  ],
  [
    "Free plan",
    "50 emails or webhooks a day, every Pro feature",
    "50 test emails a month, 1 sandbox, 1 user",
  ],
  [
    "Paid plans",
    "Pro $8/mo (100,000 a month), Business $29/mo (250,000)",
    "Basic $17, Team $42, Business $123, Enterprise $498 a month",
  ],
  [
    "Emails kept",
    "7 days on Free, 31 on Pro, 90 on Business",
    "10 to 1,000 per sandbox by plan, oldest removed first",
  ],
  [
    "One address per test run",
    "Yes, any +tag on the endpoint's address",
    "Plus aliases, Basic and up",
  ],
  ["Codes and links picked out", "Yes: dashboard, API, SDKs and MCP", "Not documented"],
  [
    "Wait for an email in a test",
    "Yes (emails.waitFor in the SDKs)",
    "Not documented; poll the API",
  ],
  ["SDKs", "TypeScript, Python and Go", "Node.js, PHP, Ruby, Python, Java, .NET, Elixir, Go"],
  ["CLI", "Yes (whk)", "Yes (Mailtrap CLI)"],
  ["MCP server for AI agents", "Yes, remote (OAuth) or local", "Yes, local (npx mcp-mailtrap)"],
  [
    "Webhook when an email arrives",
    "Yes, signed JSON with retries, up to 10 destinations",
    "Not for sandboxes (its other products have them)",
  ],
  ["Spam score", "Yes (rspamd)", "Yes (SpamAssassin), with a blacklist report"],
  ["HTML check against email clients", "No", "Yes (HTML Check)"],
  [
    "Email client screenshots",
    "No; desktop and mobile width preview",
    "Device Previews, an add-on on paid plans, on request (100+ configurations)",
  ],
  ["Forward test mail to a real inbox", "No", "Yes, Basic and up"],
  ["Webhook capture on the same endpoint", "Yes", "No"],
  ["Team seats", "Teams from $12/seat/mo", "3 on Basic, 5 on Team, 50 on Business"],
  ["SSO", "No", "Enterprise"],
  ["Open source", "Yes (AGPL + MIT)", "SDKs and Mailtrap Local"],
] as const;

export const metadata = createPageMetadata({
  title: "Mailtrap Alternative for Email Testing in CI (2026)",
  description:
    "webhooks.cc vs Mailtrap Email Sandbox: real test addresses with codes and links picked out for Playwright and CI, against a fake SMTP server with HTML and spam checks. Prices and limits compared.",
  path: "/compare/mailtrap",
  keywords: [
    "mailtrap alternative",
    "mailtrap alternatives",
    "mailtrap vs",
    "mailtrap email sandbox alternative",
    "webhooks.cc vs mailtrap",
    "email testing tool",
    "fake smtp alternative",
    "email testing api",
  ],
});

export default function CompareMailtrapPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Mailtrap", path: "/compare/mailtrap" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Mailtrap</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Mailtrap Email Sandbox is a fake SMTP server: point your app at it and it traps what the
          app sends, then checks the HTML and the spam score. webhooks.cc takes the other route to{" "}
          <Link href="/email-testing" className="text-primary font-bold hover:underline">
            email testing
          </Link>
          : every endpoint has a real address, your app sends through its normal provider, and the
          SDK hands your test the one-time code or the link from the email that arrived. If you are
          looking for a Mailtrap alternative for end-to-end tests in Playwright, Cypress or CI, this
          is how the two compare.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <ComparisonTable
          tools={[{ name: "webhooks.cc", ours: true }, { name: "Mailtrap Email Sandbox" }]}
          rows={ROWS}
          className="mb-3"
        />
        <p className="text-sm text-muted-foreground mb-10">
          Mailtrap as listed on mailtrap.io and docs.mailtrap.io in November 2026, monthly billing;
          &quot;not documented&quot; means we did not find it there. Check its pricing before you
          buy.
        </p>

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <Card>
            <h3 className="text-lg font-bold mb-2">A real address or a fake SMTP server</h3>
            <p className="text-muted-foreground">
              With Mailtrap you swap your app&apos;s SMTP settings for a sandbox&apos;s credentials,
              and every message the app sends is trapped there whoever it is addressed to. That is
              safe for staging, and it means the test does not exercise your real mail provider.
              With webhooks.cc nothing in the app changes: the test signs up with{" "}
              <InlineCode>my-app+run-42@mailhooks.cc</InlineCode>, the app sends through Resend,
              Postmark, SES or whatever it uses in production, and the email is captured as it
              really arrived, sender checks included.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Built for the test, or for the template</h3>
            <p className="text-muted-foreground">
              webhooks.cc is built around what an automated test needs: a tag per test run,{" "}
              <InlineCode>emails.waitFor()</InlineCode> in the TypeScript, Python and Go SDKs, and
              the code or the link already picked out. Mailtrap is stronger on the message itself:
              HTML Check lists the email clients that lack support for each element, the spam report
              runs SpamAssassin and a blacklist lookup, and Device Previews (an add-on on paid
              plans, on request) screenshots the email in more than 100 client configurations.
              webhooks.cc has a spam score and a deliverability report, but no client support check
              and no screenshots.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Volume and price</h3>
            <p className="text-muted-foreground">
              Mailtrap&apos;s free sandbox takes 50 test emails a month and keeps 10; its paid plans
              run from $17 a month (500 test emails, 50 kept) to $498 (unlimited). webhooks.cc
              counts an email as one request: 50 a day on Free, 100,000 a month on Pro at $8, and
              250,000 on Business at $29, kept for 7, 31 and 90 days. Mailtrap includes seats in
              each plan (3 on Basic, 5 on Team); webhooks.cc shares endpoints through Teams at $12
              per seat.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Email and webhooks in one place</h3>
            <p className="text-muted-foreground">
              A signup usually sends a confirmation email and fires a webhook. On webhooks.cc both
              land on the same endpoint and in the same list, and each endpoint can send what it
              receives on to your server as signed JSON, to Slack, Discord, Google Sheets, Zapier or
              Make. Mailtrap covers the other direction too: the same account sends production email
              through its Email API, with one SDK that switches to the sandbox by a flag.
            </p>
          </Card>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Signup, magic link and password reset tests in Playwright, Cypress or CI</li>
              <li>The one-time code or the link handed to the test</li>
              <li>Mail sent through your real provider, with SPF, DKIM and DMARC results</li>
              <li>More than a handful of test emails on a free plan</li>
              <li>Webhooks and email on the same endpoint</li>
              <li>A webhook or a Slack message when an email arrives</li>
              <li>Open-source code you can inspect</li>
            </ul>
          </Card>
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose Mailtrap when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>A fake SMTP server that traps everything staging sends</li>
              <li>An HTML and CSS support check across email clients</li>
              <li>Screenshots of the email in real clients and devices</li>
              <li>Test mail forwarded to real inboxes for review</li>
              <li>Sending and testing from one vendor</li>
              <li>SSO and audit logs on Enterprise</li>
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
        <PairLinks tool="/compare/mailtrap" />
        <p className="text-sm text-muted-foreground mb-0">
          See also:{" "}
          <Link
            href="/compare/mailosaur"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Mailosaur
          </Link>
          {" · "}
          <Link
            href="/compare/mailslurp"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs MailSlurp
          </Link>
          {" · "}
          <Link
            href="/docs/guides/test-signup-emails-playwright"
            className="font-semibold hover:text-primary transition-colors"
          >
            Email testing in Playwright
          </Link>
          {" · "}
          <Link href="/compare" className="font-semibold hover:text-primary transition-colors">
            All comparisons
          </Link>
        </p>

        {/* CTA */}
        <ComparisonCTA heading="Start testing email in under a minute" />
      </article>
    </main>
  );
}
