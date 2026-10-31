import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { SiteHeader } from "@/components/nav/site-header";
import { FAQAccordion } from "@/components/landing/faq-accordion";
import { PricingCTA } from "@/components/landing/pricing-cta";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";
import { MAILHOOKS_FEATURES, type MailhooksFeature } from "@/lib/mailhooks-features";
import { JsonLd, faqSchema, howToSchema } from "@/lib/schemas";
import { webhooksOrigin } from "@/lib/site";
import { cn } from "@/lib/utils";

/** A small table for a feature page's examples; `note` is a mono line under a header. */
export function FeatureTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: { header: string; note?: string; mono?: boolean }[];
  rows: string[][];
}) {
  return (
    <div className="ui-card ui-card-static overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b-strong border-line">
            {columns.map((column) => (
              <th key={column.header} scope="col" className="text-left py-2 pr-6 last:pr-0">
                <span className="font-bold">{column.header}</span>
                {column.note && (
                  <span className="block font-mono text-xs font-normal text-muted-foreground">
                    {column.note}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.join("|")} className="border-b border-foreground/10 last:border-0">
              {row.map((cell, i) => (
                <td
                  key={columns[i]?.header ?? i}
                  className={cn("py-2 pr-6 last:pr-0", columns[i]?.mono && "font-mono text-xs")}
                >
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

/**
 * A mailhooks.cc feature page (lib/mailhooks-features.ts): what it does, how
 * to set it up, its limits and questions, then the other features. The
 * page's own sections, such as an example, go in `children`, between the
 * steps and the limits.
 */
export function FeaturePage({
  feature,
  children,
}: {
  feature: MailhooksFeature;
  children?: React.ReactNode;
}) {
  const others = MAILHOOKS_FEATURES.filter((other) => other.path !== feature.path);
  return (
    <>
      <JsonLd data={faqSchema(feature.faq)} />
      <JsonLd
        data={howToSchema({
          name: feature.heading,
          description: feature.description,
          steps: feature.steps,
        })}
      />
      <SiteHeader />
      <main className="py-16 px-4">
        <article className="max-w-4xl mx-auto">
          <p className="text-xs font-bold caps text-muted-foreground mb-3">{feature.plans}</p>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">{feature.heading}</h1>
          <p className="text-xl text-muted-foreground mb-8">{feature.intro}</p>
          <div className="flex flex-wrap items-center gap-4 mb-14">
            <div className="w-full sm:w-auto sm:min-w-80">
              <PricingCTA />
            </div>
            <span className="text-sm text-muted-foreground">{feature.planNote}</span>
          </div>

          <section className="mb-12">
            <h2 className="text-2xl md:text-3xl font-bold mb-6">Set it up</h2>
            <ol className="space-y-4">
              {feature.steps.map((step, i) => (
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
            <p className="text-sm text-muted-foreground mt-6">
              Every setting, in full:{" "}
              <Link
                href={`${webhooksOrigin()}${feature.docs.path}`}
                className="text-primary font-bold hover:underline"
              >
                {feature.docs.label}
                <ArrowRight className="inline-block ml-1 h-4 w-4" aria-hidden />
              </Link>
            </p>
          </section>

          {children}

          <section className="mb-12">
            <h2 className="text-2xl md:text-3xl font-bold mb-6">What to know</h2>
            <ul className="grid sm:grid-cols-2 gap-3">
              {feature.limits.map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <Check className="h-5 w-5 text-primary shrink-0 mt-0.5" aria-hidden />
                  <span className="text-sm">{item}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground mt-4">
              Plans, prices and limits:{" "}
              <Link href="/pricing" className="text-primary font-bold hover:underline">
                Pricing
              </Link>
            </p>
          </section>

          <section className="mb-12">
            <h2 className="text-2xl md:text-3xl font-bold mb-6">Questions</h2>
            <FAQAccordion items={feature.faq} />
          </section>

          <section className="mt-16">
            <h2 className="text-2xl font-bold mb-6">More on mailhooks.cc</h2>
            <ul className="grid sm:grid-cols-2 gap-4">
              {others.map((other) => (
                <li key={other.path}>
                  <Link href={other.path} className="ui-card block h-full">
                    <p className="font-bold mb-1">{other.name}</p>
                    <p className="text-sm text-muted-foreground">{other.summary}</p>
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/parse" className="ui-card block h-full">
                  <p className="font-bold mb-1">Ready-made layouts</p>
                  <p className="text-sm text-muted-foreground">
                    Orders, bookings, receipts and reports from the senders you already use.
                  </p>
                </Link>
              </li>
            </ul>
          </section>
        </article>
      </main>
      <MailhooksFooter />
    </>
  );
}
