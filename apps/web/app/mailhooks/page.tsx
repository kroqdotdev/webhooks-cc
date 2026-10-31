import Link from "next/link";
import {
  ArrowRight,
  AtSign,
  Bell,
  FileSpreadsheet,
  History,
  ListOrdered,
  Send,
  ShieldCheck,
  Terminal,
  Wand2,
} from "lucide-react";
import { SiteHeader } from "@/components/nav/site-header";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { PricingCTA } from "@/components/landing/pricing-cta";
import { EmailToJson } from "@/components/mailhooks/email-to-json";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";
import { LAYOUT_TEMPLATES, layoutTemplate } from "@/lib/layout-templates";
import { MAILHOOKS_FEATURES } from "@/lib/mailhooks-features";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";
import { JsonLd, faqSchema, type FAQItem } from "@/lib/schemas";

export const metadata = mailhooksMetadata({
  title: "mailhooks.cc: Parse emails into JSON, from orders to reports",
  absoluteTitle: true,
  description:
    "Give each sender an address, describe its emails once, and get every order, booking, receipt or report as JSON at your webhook, rows in Google Sheets, or a Slack message. Free to start.",
  path: "/",
  keywords: [
    "email parser",
    "parse emails to json",
    "email to webhook",
    "email to google sheets",
    "parse email attachments",
    "csv email attachment to json",
    "order email parser",
  ],
});

const STEPS = [
  {
    icon: AtSign,
    title: "An address for every sender",
    text: "Each endpoint gets an address like acme-orders@mailhooks.cc. Forward a mailbox to it with a rule in Gmail or Outlook, or give it to the sender. A +tag after the name tells sources apart.",
  },
  {
    icon: Wand2,
    title: "Describe the email once",
    text: "A layout picks out the values you need, turns order lines into line items and parses CSV, Excel and PDF attachments. Try it on a real email as you type, before it touches anything.",
  },
  {
    icon: Send,
    title: "Deliver it where it is needed",
    text: "Signed JSON to your webhook, a row per order or per line in Google Sheets, a message in Slack or Discord. Failed deliveries are retried, and you can replay any email.",
  },
];

const FEATURES = [
  {
    icon: ListOrdered,
    title: "Line items",
    text: "An order with three products becomes three rows, from the email's text or from an attached sheet.",
  },
  {
    icon: FileSpreadsheet,
    title: "Attachments",
    text: "CSV, TSV, Excel, OpenDocument and PDF text parsed in a sandbox; files also go along as signed links or inline.",
  },
  {
    icon: Bell,
    title: "Alerts",
    text: "An email when a field stops matching, when no layout fits, when mail stops arriving, or when a destination keeps failing.",
  },
  {
    icon: History,
    title: "Replay",
    text: "Fix a pattern, then read earlier emails again and send them to their destinations once more.",
  },
  {
    icon: ShieldCheck,
    title: "Retention you choose",
    text: "Kept 7, 31 or 90 days by plan, stored in the EU, or deleted as soon as every destination has its copy.",
  },
  {
    icon: Terminal,
    title: "API, SDKs and MCP",
    text: "The same parsed JSON from the REST API, the TypeScript, Python and Go SDKs, the CLI and the MCP server for AI agents.",
  },
];

const FAQ: FAQItem[] = [
  {
    question: "What is mailhooks.cc?",
    answer:
      "The mail-first side of webhooks.cc. It is the same account, the same endpoints and the same plans, for people who receive their data by email. Sign in on either site and you see the same endpoints.",
  },
  {
    question: "Do I have to change my email provider?",
    answer:
      "No. Forward the emails you want read to your endpoint's address with a forwarding rule in Gmail, Outlook or your mail server, or give the address straight to the sender.",
  },
  {
    question: "Which attachments can be parsed?",
    answer:
      "CSV, TSV, Excel (XLSX and XLS), OpenDocument spreadsheets, the text of PDFs (no OCR) and plain text files. Each started 1,000 rows of a sheet, each PDF page and each text file is one parsed page: Free includes 20 a month, Pro 100 and Business 2,000.",
  },
  {
    question: "What happens to an email no layout fits?",
    answer:
      "It is still captured and delivered, marked with no matching layout, and an alert can tell you. Add or fix a layout and replay the emails it missed.",
  },
  {
    question: "Where is my mail kept, and for how long?",
    answer:
      "Emails and their attachments are stored in the EU and deleted after your plan's retention: 7 days on Free, 31 on Pro, 90 on Business. Any endpoint can keep them for less, or delete each email once every destination has its copy.",
  },
  {
    question: "Is there an API?",
    answer:
      "Yes: the REST API, SDKs for TypeScript, Python and Go, a CLI that forwards emails to localhost, and an MCP server so AI agents can read and wait for emails. The parsed result is part of every email's JSON.",
  },
];

export default function MailhooksHome() {
  const example = layoutTemplate("shopify-orders")!;
  return (
    <>
      <JsonLd data={faqSchema(FAQ)} />
      <SiteHeader />

      <main>
        <section className="py-20 px-4">
          <div className="max-w-6xl mx-auto">
            <div className="max-w-3xl">
              <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
                Turn the emails you receive into structured data
              </h1>
              <p className="text-xl text-muted-foreground mb-8">
                Give each sender its own address. Describe its emails once, and every order,
                booking, receipt or report arrives as JSON at your webhook, as rows in Google
                Sheets, or as a message in Slack or Discord.
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <div className="w-full sm:w-auto sm:min-w-80">
                  <PricingCTA />
                </div>
                <Link href="/parse" className="ui-btn-outline inline-flex items-center gap-2">
                  See ready-made layouts
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <p className="text-sm text-muted-foreground mt-4">
                Free: 50 emails a day and 20 parsed attachment pages a month. No credit card.
              </p>
            </div>
            <div className="mt-14">
              <EmailToJson template={example} />
            </div>
          </div>
        </section>

        <section className="py-20 px-4 bg-muted">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold mb-10">How it works</h2>
            <ol className="grid md:grid-cols-3 gap-6">
              {STEPS.map((step, index) => (
                <li key={step.title} className="ui-card ui-card-static">
                  <step.icon className="h-6 w-6 text-primary mb-4" aria-hidden />
                  <p className="text-xs font-bold caps text-muted-foreground mb-2">
                    Step {index + 1}
                  </p>
                  <h3 className="font-bold text-xl mb-2">{step.title}</h3>
                  <p className="text-muted-foreground">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="py-20 px-4">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Ready-made layouts</h2>
            <p className="text-xl text-muted-foreground mb-10 max-w-2xl">
              Start from a sender you already get email from, then adjust it to your own emails in
              the preview.
            </p>
            <ul className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {LAYOUT_TEMPLATES.slice(0, 8).map((template) => (
                <li key={template.id}>
                  <Link href={`/parse/${template.id}`} className="ui-card block h-full">
                    <p className="font-bold mb-1">{template.sender}</p>
                    <p className="text-sm text-muted-foreground">{template.kind}</p>
                  </Link>
                </li>
              ))}
            </ul>
            <Link
              href="/parse"
              className="inline-flex items-center gap-2 mt-6 font-medium hover:underline"
            >
              All {LAYOUT_TEMPLATES.length} senders
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>

        <section className="py-20 px-4 bg-muted">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold mb-10">Built for mail that matters</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="ui-card ui-card-static">
                  <feature.icon className="h-6 w-6 text-primary mb-4" aria-hidden />
                  <h3 className="font-bold text-lg mb-2">{feature.title}</h3>
                  <p className="text-muted-foreground">{feature.text}</p>
                </div>
              ))}
            </div>
            <h3 className="text-xl font-bold mt-12 mb-4">More features</h3>
            <ul className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
              {MAILHOOKS_FEATURES.map((feature) => (
                <li key={feature.path}>
                  <Link href={feature.path} className="ui-card block h-full">
                    <p className="font-bold mb-1">{feature.name}</p>
                    <p className="text-sm text-muted-foreground">{feature.summary}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="py-20 px-4">
          <div className="max-w-6xl mx-auto grid md:grid-cols-3 gap-6">
            {[
              {
                name: "Free",
                price: "$0",
                lines: ["50 emails a day", "20 parsed pages a month", "5 AI assists every 30 days"],
              },
              {
                name: "Pro",
                price: "$8 a month",
                lines: [
                  "100,000 emails and webhooks",
                  "100 parsed pages a month",
                  "20 AI assists every 30 days",
                ],
              },
              {
                name: "Business",
                price: "$29 a month",
                lines: [
                  "250,000 emails and webhooks",
                  "2,000 parsed pages a month, 50 layouts",
                  "Your own domain and file drops",
                ],
              },
            ].map((plan) => (
              <div key={plan.name} className="ui-card ui-card-static">
                <p className="font-bold text-xl">{plan.name}</p>
                <p className="text-2xl font-bold mt-1 mb-4">{plan.price}</p>
                <ul className="space-y-1 text-muted-foreground">
                  {plan.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
            <Link
              href="/pricing"
              className="md:col-span-3 inline-flex items-center gap-2 font-medium hover:underline"
            >
              Compare plans
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>

        <section id="faq" className="py-20 px-4 bg-muted scroll-mt-20">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold mb-10">Questions</h2>
            <FAQAccordion items={FAQ} />
          </div>
        </section>
      </main>

      <MailhooksFooter />
    </>
  );
}
