import Link from "next/link";
import { Check } from "lucide-react";
import { SiteHeader } from "@/components/nav/site-header";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { PricingCTA } from "@/components/landing/pricing-cta";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";
import { JsonLd, faqSchema, type FAQItem } from "@/lib/schemas";
import { webhooksOrigin } from "@/lib/site";

export const metadata = mailhooksMetadata({
  title: "Pricing",
  description:
    "Free to start with 50 emails a day. Pro $8 a month. Business $29 a month or $290 a year, with 2,000 parsed attachment pages, 50 layouts per endpoint, your own domain and file drops.",
  path: "/pricing",
  keywords: ["email parser pricing", "email parsing api pricing", "parse email attachments"],
});

const PLANS = [
  {
    name: "Free",
    price: "$0",
    note: "forever",
    lines: [
      "50 emails or webhooks a day",
      "20 parsed attachment pages a month",
      "2 layouts per endpoint",
      "5 AI assists every 30 days",
      "7-day retention",
      "Unlimited endpoints",
      "Webhook, Sheets and chat destinations",
    ],
  },
  {
    name: "Pro",
    price: "$8",
    note: "a month",
    lines: [
      "100,000 emails or webhooks per 30 days",
      "100 parsed attachment pages a month",
      "2 layouts per endpoint",
      "20 AI assists every 30 days",
      "31-day retention",
      "Unlimited endpoints",
      "Extra requests in blocks of 25,000",
    ],
  },
  {
    name: "Business",
    price: "$29",
    note: "a month, or $290 a year",
    lines: [
      "250,000 emails or webhooks a month",
      "2,000 parsed attachment pages a month",
      "Up to 50 layouts per endpoint",
      "500 AI assists every 30 days",
      "90-day retention",
      "1 custom inbound domain, extra ones $3 a month",
      "File drops to SFTP, FTP/FTPS and S3",
    ],
  },
];

const FAQ: FAQItem[] = [
  {
    question: "What counts as an email?",
    answer:
      "Each email an endpoint receives counts once against the same allowance as webhooks: one email to one endpoint is one request. Deliveries to your destinations do not count again.",
  },
  {
    question: "What is a parsed page?",
    answer:
      "Each PDF page, each started 1,000 rows of a sheet in a CSV, TSV, Excel or OpenDocument file, and each plain text attachment. Email bodies never count. Without pages left, emails still arrive with their attachments as files, unparsed.",
  },
  {
    question: "What are custom domains and file drops?",
    answer:
      "Two Business features. A custom domain lets mail arrive at an address on a domain you own, such as orders@inbound.acme.com: one is included, and each extra one is $3 a month. A file drop writes each email, or each batch, as a CSV, XML or JSON file to your SFTP, FTP/FTPS or S3-compatible server.",
  },
  {
    question: "What is an AI assist?",
    answer:
      "One ask to AI setup: it proposes the patterns for a field or a whole layout from up to 5 emails you pick, or repairs a field that stopped matching. Free includes 5 every 30 days, Pro 20 and Business 500. The patterns then run on our servers like any others; the AI never reads your mail after that.",
  },
  {
    question: "What if I need more pages on Business?",
    answer:
      "Add monthly blocks of 1,000 pages for $5, buy one-time blocks for $8 that never expire, or turn on overage at $0.01 a page up to a maximum you set.",
  },
  {
    question: "Can I change plans later?",
    answer:
      "Yes. Moving from Pro to Business applies at once: you pay the difference for the rest of the period and get Business's extra requests and pages for that part of it. Other changes take effect at the renewal and can be undone until then.",
  },
  {
    question: "Is it the same account as webhooks.cc?",
    answer:
      "Yes. One account, one plan and the same endpoints on both sites; each site keeps its own sign-in.",
  },
];

export default function MailhooksPricing() {
  return (
    <>
      <JsonLd data={faqSchema(FAQ)} />
      <SiteHeader />
      <main className="py-16 px-4">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">Pricing</h1>
          <p className="text-xl text-muted-foreground mb-12 max-w-2xl">
            Start free: Free has every Pro feature except buying extra requests. Business adds more
            parsed pages, more layouts, custom domains, file drops and longer retention.
          </p>

          <div className="grid md:grid-cols-3 gap-6">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`ui-card flex flex-col ${plan.name === "Business" ? "border-primary" : ""}`}
              >
                <h2 className="font-bold text-2xl mb-2">{plan.name}</h2>
                <p className="text-5xl font-bold">
                  {plan.price}
                  <span className="text-lg font-normal text-muted-foreground"> {plan.note}</span>
                </p>
                <ul className="space-y-3 my-8 flex-1">
                  {plan.lines.map((line) => (
                    <li key={line} className="flex items-start gap-3">
                      <Check className="h-5 w-5 text-primary shrink-0 mt-0.5" aria-hidden />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                <PricingCTA />
              </div>
            ))}
          </div>

          <div className="ui-card ui-card-static mt-8">
            <h2 className="font-bold text-xl mb-2">Teams</h2>
            <p className="text-muted-foreground">
              $12 per seat a month, with 100,000 pooled requests per seat. Add Team Business for $49
              a month: 150,000 more requests in the pool, 2,000 pooled parsed pages, 50 layouts per
              endpoint, 500 AI assists, a custom domain, file drops and 90-day retention for the
              endpoints you share.{" "}
              <Link href={`${webhooksOrigin()}/for-teams`} className="underline">
                About teams
              </Link>
            </p>
          </div>

          <section className="mt-20 max-w-3xl">
            <h2 className="text-3xl font-bold mb-8">Questions</h2>
            <FAQAccordion items={FAQ} />
          </section>
        </div>
      </main>
      <MailhooksFooter />
    </>
  );
}
