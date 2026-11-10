import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonCTA } from "@/components/compare/comparison-cta";

const FAQ_ITEMS = [
  {
    question: "What is a good Mailosaur alternative with a free plan?",
    answer:
      "webhooks.cc has a free plan with no time limit: 50 emails or webhooks a day, kept for 7 days, with every Pro feature, including real test addresses, the SDKs for TypeScript, Python and Go, the CLI and the MCP server. Mailosaur's pricing page lists a 14-day free trial and plans from $20 a month billed annually, and no free plan. Mailosaur does more around the email: SMS numbers, real-device previews and a hosted authenticator.",
  },
  {
    question: "What is the difference between webhooks.cc and Mailosaur?",
    answer:
      "Both give tests real email addresses, wait for the message and pick out its codes and links. Mailosaur is a wider, paid testing suite: SMS testing on dedicated phone numbers, email previews on real devices, TOTP authenticator codes, SMTP, POP3 and IMAP access, and client libraries in seven languages. webhooks.cc is smaller and cheaper: email and webhooks on the same endpoint, a webhook or Slack message when mail arrives, a CLI, open-source code, a free plan, and Pro at $8 a month.",
  },
  {
    question: "How does pricing compare?",
    answer:
      "Mailosaur lists Personal from $20 a month (1 inbox, a daily limit of 500 emails, 1 user) and Core from $50 a month (multiple inboxes, 2,500 emails a day, 5 seats), both billed annually, with SMS testing from $37.50 a month and email previews from $25 a month as add-ons on Core. webhooks.cc is free for 50 emails a day, $8 a month for 100,000 a month on Pro and $29 for 250,000 on Business, billed monthly. Mailosaur's figures are from its pricing page in November 2026.",
  },
  {
    question: "Can webhooks.cc test SMS or two-factor authenticator codes?",
    answer:
      "No. webhooks.cc captures email and HTTP webhooks only. For one-time codes sent by SMS, or codes from an authenticator app (TOTP), Mailosaur has dedicated phone numbers and a virtual authenticator, the latter on its Core plan and above. One-time codes sent by email work on webhooks.cc: extractCode(email) returns them.",
  },
  {
    question: "How do I move a Playwright test from Mailosaur to webhooks.cc?",
    answer:
      "Replace the address anything@SERVER_ID.mailosaur.net with client.emails.address(slug, tag), which gives slug+tag@mailhooks.cc, and replace messages.get() and its search criteria with client.emails.waitFor(slug, { tag }). Where the test read message.html.codes[0].value or message.html.links[0].href, call extractCode(email) or extractLink(email). The subject, sender, text, HTML and attachments are on email.email.",
  },
  {
    question: "Do both have an MCP server for AI coding agents?",
    answer:
      "Yes. webhooks.cc has a remote MCP server with OAuth sign-in and a local one (npx @webhooks-cc/mcp), on every plan, with tools that wait for an email and return its code and link. Mailosaur announced MCP access in November 2026 for its Core, Enterprise and Custom plans; Personal and trial accounts ask its sales team for access.",
  },
];

const ROWS = [
  ["Primary focus", "Capturing real email and webhooks for tests", "Email and SMS testing suite"],
  [
    "How mail gets in",
    "A real address per endpoint ({slug}@mailhooks.cc), from any sender",
    "Real addresses at {inbox}.mailosaur.net, or SMTP to the inbox",
  ],
  ["Free plan", "50 emails or webhooks a day, every Pro feature", "None; 14-day free trial"],
  [
    "Paid plans",
    "Pro $8/mo, Business $29/mo, billed monthly",
    "Personal from $20/mo, Core from $50/mo, billed annually",
  ],
  [
    "Email volume",
    "100,000 a month on Pro, 250,000 on Business",
    "500 a day on Personal, 2,500 a day on Core",
  ],
  [
    "One address per test run",
    "Yes, any +tag on the endpoint's address",
    "Yes, unlimited addresses per inbox",
  ],
  [
    "Codes and links picked out",
    "Yes: dashboard, API, SDKs and MCP",
    "Yes (codes and links arrays)",
  ],
  ["Wait for an email in a test", "Yes (emails.waitFor)", "Yes (messages.get)"],
  ["SDKs", "TypeScript, Python and Go", "Node.js, Python, Java, .NET, Ruby, PHP, Go"],
  ["Cypress", "Through the SDK or the REST API", "Official plugin (cypress-mailosaur)"],
  ["CLI", "Yes (whk)", "Not documented"],
  ["MCP server for AI agents", "Yes, every plan, remote (OAuth) or local", "Yes, Core and up"],
  [
    "Webhook when an email arrives",
    "Yes, signed JSON with retries, up to 10 destinations",
    "Not documented; forwarding rules send to email addresses",
  ],
  [
    "Sender checks",
    "SPF, DKIM, DMARC, spam score (rspamd), deliverability report",
    "SPF, DKIM, DMARC, SpamAssassin, blocklists",
  ],
  ["SMS testing", "No", "Add-on on Core, from $37.50/mo"],
  [
    "Email client screenshots",
    "No; desktop and mobile width preview",
    "Add-on on Core, from $25/mo",
  ],
  ["Authenticator (TOTP) codes", "No", "Yes, Core and up"],
  ["Send or reply from the inbox", "No, receive only", "Yes, Core and up, to verified addresses"],
  ["Your own domain", "Business", "Enterprise"],
  ["Webhook capture on the same endpoint", "Yes", "No"],
  ["Team seats", "Teams from $12/seat/mo", "1 on Personal (up to 3), 5 on Core"],
  ["SSO", "No", "Enterprise (SAML, OIDC)"],
  ["Open source", "Yes (AGPL + MIT)", "Client libraries on GitHub"],
] as const;

export const metadata = createPageMetadata({
  title: "Mailosaur Alternative with a Free Plan (2026)",
  description:
    "webhooks.cc vs Mailosaur for email testing in Playwright, Cypress and CI: real test addresses, wait-for-email and code extraction on both. Free plan and $8 Pro against plans from $20, SMS and previews.",
  path: "/compare/mailosaur",
  keywords: [
    "mailosaur alternative",
    "mailosaur alternatives",
    "mailosaur free alternative",
    "mailosaur vs",
    "mailosaur pricing",
    "webhooks.cc vs mailosaur",
    "email testing tool",
    "playwright email testing",
  ],
});

export default function CompareMailosaurPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs Mailosaur", path: "/compare/mailosaur" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold caps text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs Mailosaur</h1>
        <p className="text-lg text-muted-foreground mb-10">
          Mailosaur and webhooks.cc solve the same problem for an end-to-end test: give it a real
          email address, wait for the message, and hand over the code or the link inside. Mailosaur
          is the wider suite, with SMS numbers, real-device previews and an authenticator, on paid
          plans from $20 a month. webhooks.cc does{" "}
          <Link href="/email-testing" className="text-primary-ink font-bold hover:underline">
            email testing
          </Link>{" "}
          and webhook testing on one endpoint, with a free plan and Pro at $8 a month. If you are
          looking for a Mailosaur alternative, this is where each one is stronger.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <div className="ui-code overflow-x-auto mb-3">
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
                  Mailosaur
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
        <p className="text-sm text-muted-foreground mb-10">
          Mailosaur as listed on mailosaur.com and in its docs in November 2026; &quot;not
          documented&quot; means we did not find it there. Check its pricing before you buy.
        </p>

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">The same test, written almost the same way</h3>
            <p className="text-muted-foreground">
              In Mailosaur a test sends to any address at its inbox&apos;s domain, calls{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">messages.get()</code>,
              which waits for the message, and reads{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">html.codes</code> or{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">html.links</code>. In
              webhooks.cc it sends to the endpoint&apos;s address with a tag for the run, calls{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">emails.waitFor()</code>,
              and reads{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">extractCode()</code> or{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">extractLink()</code>.
              Mailosaur has client libraries for more languages and an official Cypress plugin;
              webhooks.cc has SDKs for TypeScript, Python and Go and a REST API for the rest.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Free plan and price</h3>
            <p className="text-muted-foreground">
              Mailosaur has a 14-day trial and no free plan; Personal starts at $20 a month and Core
              at $50, billed annually, with daily limits of 500 and 2,500 emails. webhooks.cc is
              free for 50 emails a day with every feature of Pro, and Pro is $8 a month for 100,000
              emails or webhooks a month. A small project&apos;s signup and login tests fit in the
              free plan.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Where Mailosaur does more</h3>
            <p className="text-muted-foreground">
              Mailosaur tests more than email. It rents dedicated phone numbers for SMS tests,
              screenshots an email in real clients on real devices, and generates authenticator
              (TOTP) codes for two-factor logins; SMS and previews are add-ons on its Core plan. It
              also checks blocklists, lets an inbox send and reply to verified addresses, and offers
              SSO and SCIM on Enterprise. webhooks.cc has none of those: it receives email and
              webhooks, and never sends.
            </p>
          </div>

          <div className="ui-card ui-card-static">
            <h3 className="text-lg font-bold mb-2">Where webhooks.cc does more</h3>
            <p className="text-muted-foreground">
              The same endpoint captures the webhooks your app fires, so a signup that sends an
              email and a webhook is checked in one place. Each endpoint can send what it receives
              to up to 10 destinations: your server as signed JSON with retries, Slack, Discord,
              Google Sheets, Zapier or Make. The{" "}
              <code className="text-sm bg-muted px-1.5 py-0.5 rounded-sm">whk</code> CLI tunnels
              captured mail to a handler on localhost, the MCP server is on every plan, and the code
              is open source.
            </p>
          </div>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Signup, magic link and password reset tests without a paid plan</li>
              <li>Email and webhooks captured on the same endpoint</li>
              <li>A webhook or a Slack message when an email arrives</li>
              <li>A CLI and an MCP server on every plan</li>
              <li>Monthly billing from $8</li>
              <li>Open-source code you can inspect</li>
            </ul>
          </div>
          <div className="ui-card ui-card-static">
            <h2 className="text-xl font-bold mb-3">Choose Mailosaur when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>SMS testing on dedicated phone numbers</li>
              <li>Screenshots of the email on real devices and clients</li>
              <li>Authenticator (TOTP) codes for two-factor tests</li>
              <li>Client libraries for Java, .NET, Ruby or PHP</li>
              <li>An inbox that sends and replies</li>
              <li>SSO, SCIM and per-team permissions</li>
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
            href="/compare/mailtrap"
            className="font-semibold hover:text-primary-ink transition-colors"
          >
            vs Mailtrap
          </Link>
          {" · "}
          <Link
            href="/compare/mailslurp"
            className="font-semibold hover:text-primary-ink transition-colors"
          >
            vs MailSlurp
          </Link>
          {" · "}
          <Link
            href="/docs/guides/test-signup-emails-playwright"
            className="font-semibold hover:text-primary-ink transition-colors"
          >
            Email testing in Playwright
          </Link>
          {" · "}
          <Link href="/compare" className="font-semibold hover:text-primary-ink transition-colors">
            All comparisons
          </Link>
        </p>

        {/* CTA */}
        <ComparisonCTA heading="Start testing email in under a minute" />
      </article>
    </main>
  );
}
