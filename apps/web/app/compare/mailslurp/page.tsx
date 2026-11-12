import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { ComparisonCTA } from "@/components/compare/comparison-cta";
import { InlineCode } from "@/components/ui/code";
import { Card } from "@/components/ui/card";

const FAQ_ITEMS = [
  {
    question: "What is a good MailSlurp alternative for email testing?",
    answer:
      "webhooks.cc covers the receiving side of email tests: a real address per endpoint ({slug}@mailhooks.cc, with a +tag per test run), SDKs for TypeScript, Python and Go that wait for the email and return its one-time code or link, and a webhook when mail arrives. Its free plan takes 50 emails a day and Pro is $8 a month. MailSlurp does more: it sends email from its inboxes, rents phone numbers for SMS, renders device previews and runs inbox placement tests.",
  },
  {
    question: "What is the difference between webhooks.cc and MailSlurp?",
    answer:
      "MailSlurp is an email and SMS API: tests create inboxes through the API, each with its own address, and can send, receive, forward and auto-reply from them, with SMTP and IMAP access. webhooks.cc only receives. Both accept plus addresses, so a test can give each run its own address on either; webhooks.cc counts requests rather than inboxes, and the same endpoint captures the webhooks your app sends.",
  },
  {
    question: "How do the free plans compare?",
    answer:
      "MailSlurp's free plan lists 250 emails received and 100 inboxes created a month for one user, with temporary inboxes only and no card needed. webhooks.cc's free plan takes 50 requests a day (an email counts as one), which is about 1,500 a month, keeps them for 7 days, and its endpoints and addresses do not expire. MailSlurp's figures are from its pricing page in November 2026.",
  },
  {
    question: "How does paid pricing compare?",
    answer:
      "MailSlurp lists Starter at $19.99 a month (2,500 emails received, 1 user, personal use), Pro at $69 (5,000 emails, 1 user, commercial use) and Growth at $199 (5,000 emails, 2 users), with extra usage billed separately on Pro and Growth. webhooks.cc Pro is $8 a month for 100,000 emails or webhooks and Business is $29 for 250,000; team seats are $12 each on Teams.",
  },
  {
    question: "Can webhooks.cc send email or receive SMS like MailSlurp?",
    answer:
      "No. mailhooks.cc addresses only receive: they never send, reply or bounce, and there are no phone numbers. A test that needs to send mail from a test inbox, or read a code from a text message, needs MailSlurp or a tool like it. One-time codes and magic links sent by email are what webhooks.cc is for.",
  },
  {
    question: "How do I move a test from MailSlurp to webhooks.cc?",
    answer:
      "Where the test created an inbox and used its address, use client.emails.address(slug, tag) with a fresh tag. Replace waitForLatestEmail() with client.emails.waitFor(slug, { tag }), and read the code or the link with extractCode(email) and extractLink(email). There is no inbox to delete afterwards; captured mail is removed when your plan's retention ends.",
  },
];

const ROWS = [
  ["Primary focus", "Capturing real email and webhooks for tests", "Email and SMS API for testing"],
  [
    "How mail gets in",
    "A real address per endpoint ({slug}@mailhooks.cc), from any sender",
    "Inboxes created by API at @mailslurp.com and its other domains",
  ],
  [
    "Free plan",
    "50 emails or webhooks a day, every Pro feature",
    "250 emails received a month, temporary inboxes, 1 user",
  ],
  [
    "Paid plans",
    "Pro $8/mo (100,000 a month), Business $29/mo (250,000)",
    "Starter $19.99, Pro $69, Growth $199 a month",
  ],
  [
    "Emails kept",
    "7 days on Free, 31 on Pro, 90 on Business",
    "By storage: 200 MB on Free up to 5 GB on Growth",
  ],
  [
    "One address per test run",
    "Yes, any +tag on the endpoint's address",
    "Yes, plus addresses on an inbox, or a new inbox (100 a month on Free)",
  ],
  ["Codes and links picked out", "Yes: dashboard, API, SDKs and MCP", "Yes, in the API and SDKs"],
  ["Wait for an email in a test", "Yes (emails.waitFor)", "Yes (waitForLatestEmail)"],
  ["SDKs", "TypeScript, Python and Go", "JavaScript, Python, Java, C#, PHP, Ruby, Go and more"],
  ["Cypress", "Through the SDK or the REST API", "Official plugin (cypress-mailslurp)"],
  ["CLI", "Yes (whk)", "No maintained CLI"],
  [
    "MCP server for AI agents",
    "Yes, remote (OAuth) or local",
    "Yes, hosted (OAuth or an agent key)",
  ],
  [
    "Webhook when an email arrives",
    "Yes, signed JSON with retries, up to 10 destinations",
    "Yes, signed, with retries",
  ],
  [
    "Deliverability checks",
    "SPF, DKIM, DMARC, spam score and a report on every email",
    "Inbox placement tests, email audits and warmup, metered",
  ],
  [
    "Send email from the inbox",
    "No, receive only",
    "Between its own inboxes on every plan; to outside addresses from Pro (500 a month)",
  ],
  ["SMS and phone numbers", "No", "Pro and up, billed separately"],
  [
    "Email client screenshots",
    "No; desktop and mobile width preview",
    "1 a month on Free to 200 on Growth",
  ],
  ["SMTP and IMAP access", "No", "Yes"],
  [
    "Your own domain",
    "Business (1 included, extra $3/mo)",
    "Add-on on Starter and Pro, 1 included on Growth",
  ],
  ["Webhook capture on the same endpoint", "Yes", "No"],
  ["Team seats", "Teams from $12/seat/mo", "1 user up to Pro, 2 on Growth"],
  ["SSO", "No", "Enterprise (SAML, OIDC)"],
  ["Open source", "Yes (AGPL + MIT)", "SDKs on GitHub"],
] as const;

export const metadata = createPageMetadata({
  title: "MailSlurp Alternative for Email Testing (2026)",
  description:
    "webhooks.cc vs MailSlurp for testing signup, magic link and reset emails: wait-for-email and code extraction on both. 50 emails a day free and $8 Pro against MailSlurp's sending, SMS and device previews.",
  path: "/compare/mailslurp",
  keywords: [
    "mailslurp alternative",
    "mailslurp alternatives",
    "mailslurp free alternative",
    "mailslurp vs",
    "mailslurp pricing",
    "webhooks.cc vs mailslurp",
    "email testing api",
    "test email address api",
  ],
});

export default function CompareMailSlurpPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "webhooks.cc vs MailSlurp", path: "/compare/mailslurp" },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />

      <article className="max-w-4xl mx-auto">
        <p className="text-xs font-bold text-muted-foreground mb-3">
          Comparison · Updated November 2026
        </p>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">webhooks.cc vs MailSlurp</h1>
        <p className="text-lg text-muted-foreground mb-10">
          MailSlurp is an email and SMS API: tests create inboxes, send and receive from them, and
          wait for messages, with SDKs in a long list of languages. webhooks.cc does the receiving
          half of{" "}
          <Link href="/email-testing" className="text-primary font-bold hover:underline">
            email testing
          </Link>
          : one endpoint with a real address and a tag per test run, a wait in the SDK, and the code
          or the link picked out, next to the webhooks the same endpoint captures. If you are
          looking for a MailSlurp alternative for signup and login tests, this is how they compare.
        </p>

        {/* Feature table */}
        <h2 className="text-2xl font-bold mb-4">Feature comparison</h2>
        <ComparisonTable
          tools={[{ name: "webhooks.cc", ours: true }, { name: "MailSlurp" }]}
          rows={ROWS}
          className="mb-3"
        />
        <p className="text-sm text-muted-foreground mb-10">
          MailSlurp as listed on mailslurp.com and in its docs in November 2026, monthly billing;
          &quot;not documented&quot; means we did not find it there. Check its pricing before you
          buy.
        </p>

        <ComparisonCTA compact />

        {/* Key differences */}
        <h2 className="text-2xl font-bold mb-4">Key differences</h2>
        <div className="space-y-6 mb-10">
          <Card>
            <h3 className="text-lg font-bold mb-2">What each plan counts</h3>
            <p className="text-muted-foreground">
              Both tools give each test run its own address without new setup: MailSlurp inboxes
              accept plus addresses and its waits can match on them, and a webhooks.cc
              endpoint&apos;s address takes any tag after a plus sign, so{" "}
              <InlineCode>my-app+run-42@mailhooks.cc</InlineCode> is ready the moment the test
              writes it, and <InlineCode>emails.waitFor(slug, {"{ tag }"})</InlineCode> only matches
              mail sent to that tag. They differ in what is counted: MailSlurp&apos;s plans count
              inboxes created and emails received each month (100 inboxes and 250 emails on Free),
              while webhooks.cc counts requests (50 a day on Free, 100,000 a month on Pro), email
              and webhooks alike.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Receive only, or a full mailbox</h3>
            <p className="text-muted-foreground">
              MailSlurp inboxes are mailboxes: they send (to outside addresses on Pro and up),
              forward and auto-reply, and can be reached over SMTP and IMAP. It also rents phone
              numbers for SMS tests, renders device previews and runs inbox placement tests and
              warmup. webhooks.cc only receives, which is all a signup, magic link or password reset
              test needs, and it shows SPF, DKIM, DMARC, a spam score and a deliverability report
              for every email at no extra charge.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Volume and price</h3>
            <p className="text-muted-foreground">
              MailSlurp&apos;s free plan receives 250 emails a month; Starter is $19.99 for 2,500
              and marked for personal use, Pro is $69 for 5,000, and Growth is $199 for 5,000 with
              two users. webhooks.cc counts an email as one request: 50 a day on Free, 100,000 a
              month on Pro at $8, 250,000 on Business at $29, and team seats at $12 each. A test
              suite that sends a few hundred emails a day fits in Pro.
            </p>
          </Card>

          <Card>
            <h3 className="text-lg font-bold mb-2">Email and webhooks in one place</h3>
            <p className="text-muted-foreground">
              Both tools post a webhook when an email arrives. webhooks.cc also captures webhooks:
              the endpoint that receives your app&apos;s confirmation email receives the events your
              app or its providers send, with signature checks, replay and a CLI tunnel to
              localhost. The code is open source, and the MCP server gives a coding agent the same
              waits and extraction as the SDK.
            </p>
          </Card>
        </div>

        {/* When to choose */}
        <div className="grid md:grid-cols-2 gap-4 mb-10">
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose webhooks.cc when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>Signup, magic link and password reset tests in Playwright, Cypress or CI</li>
              <li>No inboxes to create or clean up</li>
              <li>Thousands of test emails a month for $8</li>
              <li>Email and webhooks captured on the same endpoint</li>
              <li>Sender checks and a spam score on every email</li>
              <li>A CLI, and open-source code you can inspect</li>
            </ul>
          </Card>
          <Card>
            <h2 className="text-xl font-bold mb-3">Choose MailSlurp when you need</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-1.5">
              <li>To send email from test inboxes, or auto-reply and forward</li>
              <li>SMS tests on rented phone numbers</li>
              <li>Device previews and inbox placement tests</li>
              <li>SMTP and IMAP access to the inboxes</li>
              <li>An SDK for Java, C#, PHP, Ruby or another language</li>
              <li>SSO, SCIM and audit logs on Enterprise</li>
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
            href="/compare/mailtrap"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Mailtrap
          </Link>
          {" · "}
          <Link
            href="/compare/mailosaur"
            className="font-semibold hover:text-primary transition-colors"
          >
            vs Mailosaur
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
