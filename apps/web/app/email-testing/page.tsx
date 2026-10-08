import Link from "next/link";
import {
  ArrowRight,
  Braces,
  Check,
  Eye,
  KeyRound,
  ListChecks,
  MailCheck,
  ShieldCheck,
} from "lucide-react";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema, howToSchema, type FAQItem } from "@/lib/schemas";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { StartFreeCTA } from "@/components/landing/start-free-cta";
import { PricingCTA } from "@/components/landing/pricing-cta";

const PATH = "/email-testing";

export const metadata = createPageMetadata({
  title: "Email Testing: Real Inboxes for Signup, OTP and Magic-Link Tests",
  description:
    "Give every test its own email address. Capture signup, password reset and login emails, read the code and the link, preview the HTML safely and check SPF, DKIM and DMARC. Free plan included.",
  path: PATH,
  keywords: [
    "email testing",
    "email testing api",
    "test email address",
    "inbound email testing",
    "test signup emails",
    "otp email testing",
    "magic link testing",
    "playwright email testing",
    "email verification testing",
    "spf dkim dmarc checker",
  ],
});

const STEPS = [
  {
    name: "Create an endpoint",
    text: "Sign up free and create an endpoint. Next to its webhook URL it has an email address: the endpoint's slug at mailhooks.cc.",
  },
  {
    name: "Use the address in your app",
    text: "Sign up, reset a password or log in with that address. Add a tag after a plus sign, like my-app+run-42@mailhooks.cc, to tell test runs apart; tagged mail lands on the same endpoint.",
  },
  {
    name: "Read the email",
    text: "The email appears in the dashboard within seconds, with the one-time code and the main link picked out for you. In an automated test, the SDK waits for it and hands you the code.",
  },
  {
    name: "Check it before you ship",
    text: "Preview the HTML at desktop and mobile widths, read the text part and the headers, and see whether SPF, DKIM and DMARC passed for your sending domain.",
  },
];

const FEATURES = [
  {
    icon: KeyRound,
    title: "Codes and links, picked out",
    text: "The one-time code and the link the email asks you to click sit at the top, each with a copy button. Unsubscribe and tracking links stay out of the way.",
  },
  {
    icon: Eye,
    title: "A preview that cannot bite",
    text: "The HTML renders in a sandboxed frame with no scripts. Remote images wait until you load them, so opening an email tells the sender nothing.",
  },
  {
    icon: ShieldCheck,
    title: "Sender checks",
    text: "SPF, DKIM, DMARC, reverse DNS and TLS for every message, with what each result means, so you see what an inbox provider would think of your mail.",
  },
  {
    icon: Braces,
    title: "The email as JSON",
    text: "Every email opens on a JSON view of the parsed message: sender, recipients, subject, text, HTML, codes, links and attachments. Copy it as a test fixture.",
  },
  {
    icon: ListChecks,
    title: "Emails next to your webhooks",
    text: "Mail lands in the same list as the endpoint's HTTP requests, so a signup that fires a webhook and a confirmation email can be checked in one place.",
  },
  {
    icon: MailCheck,
    title: "Headers, raw source and .eml",
    text: "Every header as it arrived, the raw message, the attachment list, and a download of the original .eml file.",
  },
];

const TEST_SAMPLE = `import { test } from "@playwright/test";
import { WebhooksCC, extractCode } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

test("sign up with a verification code", async ({ page }) => {
  const runId = \`signup-\${Date.now()}\`;
  await page.goto("/signup");
  await page.getByLabel("Email").fill(client.emails.address("my-app", runId));
  await page.getByRole("button", { name: "Sign up" }).click();

  // Waits until the email for this run arrives, up to 60 seconds.
  const email = await client.emails.waitFor("my-app", { tag: runId });
  await page.getByLabel("Verification code").fill(extractCode(email)!);
});`;

const FAQ_ITEMS: FAQItem[] = [
  {
    question: "How do I test signup and verification emails?",
    answer:
      "Create a free webhooks.cc endpoint and use its email address, your-slug@mailhooks.cc, in the signup form. The confirmation email shows up in the dashboard within seconds with the code and the link picked out, or your test waits for it with the SDK.",
  },
  {
    question: "How do I read a one-time code in a Playwright or Cypress test?",
    answer:
      "Sign up with a tagged address such as your-slug+run-42@mailhooks.cc, so each test run finds its own email. With the TypeScript SDK, client.emails.waitFor(slug, { tag }) waits for the email and extractCode(email) returns the code. From other languages, poll the requests API with kind=email; each email comes back as JSON with its subject, sender, text, HTML and attachment list.",
  },
  {
    question: "Does email testing cost extra?",
    answer:
      "No. Email capture is on every plan, Free included. Each email counts as one request against the same quota as your webhooks: 50 a day on Free, 100,000 a month on Pro.",
  },
  {
    question: "Can I get an email address without an account?",
    answer:
      "No. Guest endpoints on the landing page receive HTTP requests only, because anyone who knows a guest slug can read what it captured. Every endpoint on a free account receives email.",
  },
  {
    question: "Does it check SPF, DKIM and DMARC?",
    answer:
      "Yes. Every message shows the SPF, DKIM and DMARC results, reverse DNS and the TLS version it arrived with. A failing check never stops a message from being captured, so you can debug a sending setup that is not right yet.",
  },
  {
    question: "Can I send or reply from a mailhooks.cc address?",
    answer:
      "No. mailhooks.cc only receives. It never sends mail, replies or bounces, so the addresses cannot be used to send spam.",
  },
  {
    question: "What happens to attachments?",
    answer:
      "Their name, type and size are listed. The contents are not kept. Messages up to 10 MB are accepted, text and HTML parts are stored up to 256 KB each, and the original message is kept when it is 1 MB or smaller.",
  },
];

export default function EmailTestingPage() {
  return (
    <main className="min-h-screen pt-32 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Email testing", path: PATH },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />
      <JsonLd
        data={howToSchema({
          name: "How to test the emails your app sends",
          description:
            "Capture signup, login and password reset emails on a webhooks.cc endpoint and read the code, the link and the sender checks.",
          steps: STEPS,
          totalTime: "PT2M",
        })}
      />

      <div className="max-w-4xl mx-auto">
        <div className="mb-12">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">
            Test the emails your app sends
          </h1>
          <p className="text-xl text-muted-foreground mb-6">
            Every endpoint on a webhooks.cc account has a real email address next to its webhook
            URL. Sign up in your app with it, then read the confirmation code, the magic link and
            the sender checks in the dashboard, or fetch the email from the API in your test.
          </p>
          <div className="ui-code mb-6 overflow-x-auto">
            <pre className="text-sm md:text-base">
              <code>
                <span className="text-muted-foreground"># Your endpoint&apos;s address</span>
                {"\n"}my-app@mailhooks.cc{"\n\n"}
                <span className="text-muted-foreground"># One per test run, same endpoint</span>
                {"\n"}my-app+run-42@mailhooks.cc
              </code>
            </pre>
          </div>
          <StartFreeCTA goCta={null} />
          <p className="text-sm text-muted-foreground mt-4">
            No credit card. Read the{" "}
            <Link href="/docs/email-capture" className="text-primary font-bold hover:underline">
              email capture docs
            </Link>{" "}
            for every detail.
          </p>
        </div>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">How to test an email flow</h2>
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
          <h2 className="text-2xl md:text-3xl font-bold mb-6">What you see for every email</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="ui-card ui-card-static">
                <feature.icon className="h-5 w-5 text-primary mb-3" aria-hidden="true" />
                <h3 className="font-bold mb-1.5">{feature.title}</h3>
                <p className="text-sm text-muted-foreground">{feature.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">Read the email in your test</h2>
          <p className="text-muted-foreground mb-6">
            The TypeScript SDK waits for the email your test triggered and picks out the code or the
            link, with the same finder the dashboard uses. Give each run its own tag so parallel
            tests never read each other&apos;s mail.
          </p>
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{TEST_SAMPLE}</code>
            </pre>
          </div>
          <p className="text-sm text-muted-foreground mt-3">
            Create the API key on your account page. Not on Node? The{" "}
            <Link href="/docs/api" className="text-primary font-bold hover:underline">
              REST API
            </Link>{" "}
            returns the same emails with <code className="font-mono">kind=email</code>, so Cypress,
            Selenium or any runner that can make an HTTP call works too.
          </p>
          <p className="text-sm text-muted-foreground mt-3">
            Step by step:{" "}
            <Link
              href="/docs/guides/test-signup-emails-playwright"
              className="text-primary font-bold hover:underline"
            >
              test signup and login emails in Playwright
            </Link>
            , with a fixture per test, magic links and CI.
          </p>
        </section>

        <section className="mb-12">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl md:text-2xl font-bold mb-2">Need the email in your own app?</h2>
            <p className="text-muted-foreground mb-4">
              Turn on forwarding and every email the endpoint receives is posted to your server as
              signed JSON, retried until your server accepts it. No mail server to run and no MIME
              to parse.
            </p>
            <Link href="/email-to-webhook" className="text-primary font-bold hover:underline">
              Email to webhook
              <ArrowRight className="inline-block ml-1 h-4 w-4" />
            </Link>
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Limits</h2>
          <ul className="grid sm:grid-cols-2 gap-3">
            {[
              "Every plan, Free included; an email counts as one request",
              "Messages up to 10 MB, up to 20 recipients each",
              "Text and HTML stored up to 256 KB each",
              "Original .eml kept for messages up to 1 MB",
              "Attachments listed by name, type and size",
              "Same retention as your HTTP requests",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Check className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <span className="text-sm">{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">Email testing questions</h2>
          <FAQAccordion items={FAQ_ITEMS} />
        </section>

        <div className="ui-card bg-foreground text-background text-center py-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-3">
            Your test inbox is one signup away
          </h2>
          <p className="opacity-80 mb-6 max-w-md mx-auto">
            Sign up free, create an endpoint, and send your first email to it.
          </p>
          <div className="flex justify-center text-foreground">
            <PricingCTA />
          </div>
          <p className="text-sm opacity-80 mt-6">No credit card</p>
        </div>
      </div>
    </main>
  );
}
