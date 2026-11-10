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
  title: "Email Testing for Developers: Signup, Magic Link and OTP in CI",
  description:
    "Test signup, magic link and password reset emails end to end in Playwright, Cypress and CI. A real address per test run, an SDK that waits for the email and returns the code or link. Free plan.",
  path: PATH,
  keywords: [
    "email testing",
    "email testing for developers",
    "playwright email testing",
    "test email magic link",
    "cypress email testing",
    "email testing api",
    "test signup emails",
    "test password reset email",
    "otp email testing",
    "email testing in ci",
    "test email address",
    "mailtrap alternative",
  ],
});

const STEPS = [
  {
    name: "Create an endpoint",
    text: "Sign up free and create an endpoint. Next to its webhook URL it has an email address: the endpoint's slug at mailhooks.cc.",
  },
  {
    name: "Give each test run its own address",
    text: "Add a tag after a plus sign, like my-app+run-42@mailhooks.cc. Tagged mail lands on the same endpoint, so there are no inboxes to create or clean up, and parallel tests never read each other's mail.",
  },
  {
    name: "Run the flow in your app",
    text: "Sign up, ask for a magic link or reset a password with that address. Your app sends the email through its real provider; nothing in its mail settings changes.",
  },
  {
    name: "Wait for the email and use what is in it",
    text: "The SDK waits until the email for that tag arrives and returns the one-time code or the link, so the test can type the code or open the link and finish the flow.",
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

const TEST_SAMPLE = `import { test, expect } from "@playwright/test";
import { WebhooksCC, extractLink } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });
const SLUG = process.env.WHK_EMAIL_ENDPOINT!; // your endpoint's slug

test("sign up and follow the magic link", async ({ page }, testInfo) => {
  // A tag per test: my-app+w0-1791450602000@mailhooks.cc
  const tag = \`w\${testInfo.workerIndex}-\${Date.now()}\`;

  await page.goto("/signup");
  await page.getByLabel("Email").fill(client.emails.address(SLUG, tag));
  await page.getByRole("button", { name: "Sign up" }).click();

  // Waits up to 60 seconds for the email sent to this test's address.
  const email = await client.emails.waitFor(SLUG, { tag });
  expect(email.email.subject).toContain("Sign in");

  // The confirm, verify, reset or sign-in link, or null when there is none.
  const link = extractLink(email, { actionOnly: true });
  expect(link).not.toBeNull();

  await page.goto(link!);
  await expect(page).toHaveURL(/\\/dashboard/);
});`;

const CODE_SAMPLE = `import { extractCode } from "@webhooks-cc/sdk";

const email = await client.emails.waitFor(SLUG, { tag, subject: "verification code" });
const code = extractCode(email); // "482913", or null when the email has none
await page.getByLabel("Verification code").fill(code!);`;

const CYPRESS_SAMPLE = `// cypress.config.ts: the SDK runs in Node, behind a task
import { defineConfig } from "cypress";
import { WebhooksCC, extractLink } from "@webhooks-cc/sdk";

const client = new WebhooksCC({ apiKey: process.env.WHK_API_KEY! });

export default defineConfig({
  e2e: {
    setupNodeEvents(on) {
      on("task", {
        async emailLink({ slug, tag }: { slug: string; tag: string }) {
          const email = await client.emails.waitFor(slug, { tag, timeout: "45s" });
          return extractLink(email, { actionOnly: true });
        },
      });
    },
  },
});

// In a test
cy.task("emailLink", { slug, tag }).then((link) => cy.visit(link as string));`;

const FLOWS = [
  {
    title: "Signup confirmation",
    text: "Fill the signup form with a tagged address, wait for the confirmation email, and enter its code or open its link.",
  },
  {
    title: "Magic link sign-in",
    text: "Ask for a sign-in link, read it with extractLink(), and open it in the same browser context so the session lands where a user's would.",
  },
  {
    title: "One-time codes",
    text: "extractCode() returns the 4 to 8 digit code (or short letter and digit code) that sits next to a word like code, verification or PIN.",
  },
  {
    title: "Password reset",
    text: "Request a reset, follow the reset link, set a new password, and sign in with it, all in one test.",
  },
];

const ALTERNATIVES = [
  {
    href: "/compare/mailtrap",
    name: "Mailtrap",
    text: "A fake SMTP server with HTML and spam checks, against real addresses with codes and links picked out.",
  },
  {
    href: "/compare/mailosaur",
    name: "Mailosaur",
    text: "The same wait-and-extract workflow with SMS and device previews, on paid plans from $20 a month.",
  },
  {
    href: "/compare/mailslurp",
    name: "MailSlurp",
    text: "An email and SMS API whose inboxes also send, against a receive-only endpoint that catches webhooks too.",
  },
];

const FAQ_ITEMS: FAQItem[] = [
  {
    question: "How do I test emails in Playwright?",
    answer:
      "Install @webhooks-cc/sdk, create an endpoint, and fill your form with client.emails.address(slug, tag), which gives slug+tag@mailhooks.cc. After the app sends its email, client.emails.waitFor(slug, { tag }) polls until it arrives (60 seconds by default) and returns the subject, sender, text, HTML and attachments. extractCode(email) and extractLink(email) return the one-time code and the link, so the test can finish the flow in the browser.",
  },
  {
    question: "How do I test a magic link email?",
    answer:
      "Ask for the link with a tagged address, wait for the email with client.emails.waitFor(slug, { tag }), and call extractLink(email, { actionOnly: true }). It returns the link the email asks you to click (sign in, confirm, verify or reset) and null when there is none, so a broken template fails the test. Open the link with page.goto() in the same browser context and check that you are signed in.",
  },
  {
    question: "How do I test password reset and one-time code emails?",
    answer:
      "The same way. For a reset, wait for the email and follow extractLink(email, { actionOnly: true }) to the reset form. For a one-time code, extractCode(email) returns the code when a word such as code, verification or PIN sits next to it, so order numbers and years are not mistaken for one.",
  },
  {
    question: "Does it work with Cypress, Selenium or other test runners?",
    answer:
      "Yes. The TypeScript SDK runs in Node, so in Cypress call it from a task (cy.task) and return the code or link to the test. The Python SDK has client.emails.wait_for and extract_code, and the Go SDK client.Emails.WaitFor and ExtractCode. From any other language, poll the requests API with kind=email and extracts=true; each email comes back as JSON with the codes and links found in it.",
  },
  {
    question: "Does it work in CI, with tests running in parallel?",
    answer:
      "Yes. Store the API key and the endpoint's slug as CI secrets. One endpoint serves the whole suite: each test uses its own +tag, and waitFor only matches mail sent to that tag, so parallel workers and concurrent pipeline runs do not see each other's email. Nothing has to be reachable from the internet, because the test fetches the email over HTTPS.",
  },
  {
    question: "Do I have to change how my app sends email?",
    answer:
      "No. There are no SMTP credentials to swap in. The address is a real one, so your app sends through whatever it uses (Resend, Postmark, SES, SendGrid, plain SMTP), and the email is captured as it really arrived, with SPF, DKIM and DMARC results. The provider has to really send: a sandbox mode that drops mail delivers nothing.",
  },
  {
    question: "Does email testing cost extra?",
    answer:
      "No. Email capture is on every plan, Free included. Each email counts as one request against the same quota as your webhooks: 50 a day on Free, 100,000 a month on Pro and 250,000 a month on Business.",
  },
  {
    question: "How is this different from Mailtrap, Mailosaur or MailSlurp?",
    answer:
      "Mailtrap Email Sandbox traps mail on a fake SMTP server and checks its HTML; webhooks.cc receives at real addresses and hands the test the code or link. Mailosaur and MailSlurp work like webhooks.cc for email and add SMS, device previews and sending, at higher prices. webhooks.cc adds webhook capture on the same endpoint, a free plan with 50 emails a day and open-source code. Each has its own comparison page.",
  },
  {
    question: "Can I get an email address without an account?",
    answer:
      "No. Guest endpoints on the landing page receive HTTP requests only, because anyone who knows a guest slug can read what it captured. Every endpoint on a free account receives email.",
  },
  {
    question: "Can I send or reply from a mailhooks.cc address?",
    answer:
      "No. mailhooks.cc only receives. It never sends mail, replies or bounces, so the addresses cannot be used to send spam.",
  },
];

export default function EmailTestingPage() {
  return (
    <main className="min-h-screen pt-12 pb-20 px-4">
      <JsonLd
        data={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Email testing", path: PATH },
        ])}
      />
      <JsonLd data={faqSchema(FAQ_ITEMS)} />
      <JsonLd
        data={howToSchema({
          name: "How to test signup, magic link and password reset emails",
          description:
            "Give each test run its own email address on a webhooks.cc endpoint, wait for the email your app sends, and finish the flow with the code or link inside it.",
          steps: STEPS,
          totalTime: "PT2M",
        })}
      />

      <div className="max-w-4xl mx-auto">
        <div className="mb-12">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">
            Email testing for developers
          </h1>
          <p className="text-xl text-muted-foreground mb-6">
            Test signup, magic link and password reset emails end to end in Playwright, Cypress and
            CI. Every endpoint on a webhooks.cc account has a real email address: your test signs up
            with it, the SDK waits for the email your app sends, and hands back the one-time code or
            the link inside.
          </p>
          <div className="ui-code mb-6 overflow-x-auto">
            <pre className="text-sm md:text-base">
              <code>
                <span className="text-muted-foreground"># Your endpoint&apos;s address</span>
                {"\n"}my-app@mailhooks.cc{"\n\n"}
                <span className="text-muted-foreground">
                  # One per test run, same endpoint, nothing to create
                </span>
                {"\n"}my-app+run-42@mailhooks.cc
              </code>
            </pre>
          </div>
          <StartFreeCTA goCta={null} />
          <p className="text-sm text-muted-foreground mt-4">
            Free for 50 emails a day, no credit card. Read the{" "}
            <Link
              href="/docs/guides/test-signup-emails-playwright"
              className="text-primary-ink font-bold hover:underline"
            >
              Playwright email testing guide
            </Link>{" "}
            or the{" "}
            <Link href="/docs/email-capture" className="text-primary-ink font-bold hover:underline">
              email capture docs
            </Link>
            .
          </p>
        </div>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">
            Test a magic link email in Playwright
          </h2>
          <p className="text-muted-foreground mb-6">
            The whole test: sign up with a tagged address, wait for the email, open the link. The
            SDK finds the link with the same finder the dashboard uses, and{" "}
            <code className="font-mono">actionOnly</code> makes a template without a sign-in link
            fail the test.
          </p>
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{TEST_SAMPLE}</code>
            </pre>
          </div>
          <p className="text-sm text-muted-foreground mt-3">
            Install with <code className="font-mono">npm install --save-dev @webhooks-cc/sdk</code>{" "}
            and create the API key on your account page. Step by step, with a fixture per test,
            password resets and CI:{" "}
            <Link
              href="/docs/guides/test-signup-emails-playwright"
              className="text-primary-ink font-bold hover:underline"
            >
              how to test emails in Playwright
            </Link>
            .
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">The email flows it covers</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {FLOWS.map((flow) => (
              <div key={flow.title} className="ui-card ui-card-static">
                <h3 className="font-bold mb-1.5">{flow.title}</h3>
                <p className="text-sm text-muted-foreground">{flow.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">
            One-time codes, Cypress and other runners
          </h2>
          <p className="text-muted-foreground mb-4">
            For a verification code, wait the same way and read it with{" "}
            <code className="font-mono">extractCode()</code>:
          </p>
          <div className="ui-code overflow-x-auto mb-6">
            <pre className="text-sm">
              <code>{CODE_SAMPLE}</code>
            </pre>
          </div>
          <p className="text-muted-foreground mb-4">
            In Cypress the SDK runs in Node, so put the wait in a task and hand the link to the
            test:
          </p>
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{CYPRESS_SAMPLE}</code>
            </pre>
          </div>
          <p className="text-sm text-muted-foreground mt-3">
            The{" "}
            <Link href="/docs/sdk/python" className="text-primary-ink font-bold hover:underline">
              Python
            </Link>{" "}
            and{" "}
            <Link href="/docs/sdk/go" className="text-primary-ink font-bold hover:underline">
              Go
            </Link>{" "}
            SDKs have the same waits and finders for pytest and Go tests, and the{" "}
            <Link href="/docs/api" className="text-primary-ink font-bold hover:underline">
              REST API
            </Link>{" "}
            returns the same emails with <code className="font-mono">kind=email</code> and{" "}
            <code className="font-mono">extracts=true</code>, so Selenium or any runner that can
            make an HTTP call works too. AI coding agents get the same through the{" "}
            <Link href="/docs/mcp" className="text-primary-ink font-bold hover:underline">
              MCP server
            </Link>
            : <code className="font-mono">wait_for_email</code> returns the email with its code and
            link. More patterns:{" "}
            <Link
              href="/docs/sdk/testing#testing-emails"
              className="text-primary-ink font-bold hover:underline"
            >
              testing emails with the SDK
            </Link>
            .
          </p>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-6">How it works</h2>
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
          <h2 className="text-2xl md:text-3xl font-bold mb-4">
            Check the email by hand before you ship
          </h2>
          <p className="text-muted-foreground mb-6">
            Every captured email also opens in the dashboard, next to the endpoint&apos;s webhooks.
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="ui-card ui-card-static">
                <feature.icon className="h-5 w-5 text-primary-ink mb-3" aria-hidden="true" />
                <h3 className="font-bold mb-1.5">{feature.title}</h3>
                <p className="text-sm text-muted-foreground">{feature.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">
            Compared with other email testing tools
          </h2>
          <p className="text-muted-foreground mb-6">
            What each tool is better at, with prices and limits from its own site.
          </p>
          <div className="grid sm:grid-cols-3 gap-4">
            {ALTERNATIVES.map((tool) => (
              <Link
                key={tool.href}
                href={tool.href}
                className="ui-card ui-card-static block transition-colors hover:bg-muted"
              >
                <h3 className="font-bold mb-1.5">webhooks.cc vs {tool.name}</h3>
                <p className="text-sm text-muted-foreground">{tool.text}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="mb-12">
          <div className="ui-card ui-card-static">
            <h2 className="text-xl md:text-2xl font-bold mb-2">Need the email in your own app?</h2>
            <p className="text-muted-foreground mb-4">
              Add a destination and every email the endpoint receives is posted to your server as
              signed JSON, retried until your server accepts it. No mail server to run and no MIME
              to parse.
            </p>
            <Link href="/email-to-webhook" className="text-primary-ink font-bold hover:underline">
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
              "The original .eml kept whole",
              "Attachments kept and downloadable",
              "Same retention as your HTTP requests",
            ].map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Check className="h-5 w-5 text-primary-ink shrink-0 mt-0.5" />
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
          <div className="flex justify-center">
            <PricingCTA inverted />
          </div>
          <p className="text-sm opacity-80 mt-6">No credit card</p>
        </div>
      </div>
    </main>
  );
}
