import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SiteHeader } from "@/components/nav/site-header";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { PricingCTA } from "@/components/landing/pricing-cta";
import { PricingPlans } from "@/components/landing/pricing-plans";
import { PRICING_FAQ } from "@/lib/pricing-faq";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, breadcrumbSchema, faqSchema } from "@/lib/schemas";

// On mailhooks.cc, /pricing is app/mailhooks/pricing (a host rewrite in next.config.ts).
const PATH = "/pricing";

export const metadata = createPageMetadata({
  title: "Pricing: Free Webhook Testing, Pro $8, Business $29",
  description:
    "Start free with 50 requests a day and every feature. Pro is $8 a month for 100,000 requests. Business is $29 a month or $290 a year with attachment parsing, custom domains and file drops. Teams from $12 a seat.",
  path: PATH,
  keywords: [
    "webhooks.cc pricing",
    "webhook testing pricing",
    "webhook tester price",
    "free webhook testing",
    "webhook inspector plans",
    "requestbin alternative pricing",
  ],
});

/** What every account can buy past its plan, from content/docs/plans-limits.mdx. */
const EXTRAS = [
  {
    title: "Extra requests",
    who: "Pro, Business and subscribed teams",
    lines: [
      "Monthly blocks: $2 per 25,000 a month, renewed with the plan",
      "One-time blocks: $3 per 25,000, kept until used",
      "Overage: $0.16 per 1,000, up to a monthly maximum you set",
    ],
  },
  {
    title: "Parsed attachment pages",
    who: "Business and Team Business",
    lines: [
      "Monthly page blocks: $5 per 1,000 a month",
      "One-time page blocks: $8 per 1,000, never expire",
      "Page overage: $0.01 a page, up to a maximum you set",
    ],
  },
];

export default function PricingPage() {
  return (
    <>
      <SiteHeader />
      <main className="min-h-screen pt-12 pb-20 px-4">
        <JsonLd
          data={breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Pricing", path: PATH },
          ])}
        />
        <JsonLd data={faqSchema(PRICING_FAQ)} />
        <div className="max-w-6xl mx-auto">
          <div className="mb-12 max-w-2xl">
            <h1 className="text-4xl md:text-5xl font-bold mb-4">Pricing</h1>
            <p className="text-xl text-muted-foreground">
              Every plan has the full toolset: capture, inspection, replay, mock responses, email,
              destinations, the CLI, SDKs and MCP server. Pro raises the limits; Business adds
              attachment parsing at volume, more layouts, custom domains, file drops and longer
              retention. Start free, no credit card.
            </p>
          </div>

          <PricingPlans headingLevel="h2" />

          <section className="mt-16">
            <h2 className="text-2xl md:text-3xl font-bold mb-2">Need more?</h2>
            <p className="text-muted-foreground mb-6 max-w-2xl">
              Go past your plan&apos;s allowance without moving up a plan. Requests are used in
              order: the plan&apos;s, monthly blocks, one-time blocks, then overage.
            </p>
            <div className="grid md:grid-cols-2 gap-6">
              {EXTRAS.map((extra) => (
                <div key={extra.title} className="ui-card ui-card-static">
                  <h3 className="font-bold text-xl mb-1">{extra.title}</h3>
                  <p className="text-sm text-muted-foreground mb-4">{extra.who}</p>
                  <ul className="space-y-2">
                    {extra.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="mt-6">
              <Link
                href="/docs/plans-limits"
                className="inline-flex items-center gap-1 font-bold text-primary-ink hover:underline"
              >
                Every limit, side by side
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </p>
          </section>

          <section className="mt-20 max-w-3xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold mb-10">Pricing questions</h2>
            <FAQAccordion items={PRICING_FAQ} />
          </section>

          <div className="ui-card bg-foreground text-background text-center py-16 mt-20">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Start free, upgrade when you need to
            </h2>
            <p className="text-xl opacity-80 mb-8 max-w-xl mx-auto">
              Your endpoints, requests and settings stay with you on every plan.
            </p>
            <div className="flex justify-center">
              <PricingCTA inverted />
            </div>
            <p className="text-sm opacity-80 mt-6">
              No credit card &middot; or{" "}
              <Link href="/" className="underline hover:no-underline">
                get a guest URL
              </Link>
              , no account needed
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
