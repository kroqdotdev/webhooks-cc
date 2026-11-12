import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SiteHeader } from "@/components/nav/site-header";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";
import { groupedTemplates } from "@/lib/layout-template-groups";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";
import { Card } from "@/components/ui/card";

export const metadata = mailhooksMetadata({
  title: "Parse emails from the senders you use",
  description:
    "Ready-made layouts that turn order, booking, receipt, form and report emails into JSON: Shopify, WooCommerce, Etsy, Amazon, eBay, Stripe, PayPal, Booking.com, Airbnb, Calendly and more.",
  path: "/parse",
  keywords: ["email parser templates", "parse order emails", "parse booking emails"],
});

export default function SendersIndex() {
  return (
    <>
      <SiteHeader />
      <main className="py-16 px-4">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">Layout gallery</h1>
          <p className="text-xl text-muted-foreground mb-12 max-w-2xl">
            Each one reads a common kind of email into fields and line items. Add it to an endpoint
            and adjust it on one of your own emails in the preview.
          </p>
          <div className="space-y-14">
            {groupedTemplates().map((group) => {
              const id = `gallery-${group.name.toLowerCase().replace(/[^a-z]+/g, "-")}`;
              return (
                <section key={group.name} aria-labelledby={id}>
                  <h2 id={id} className="text-2xl font-bold mb-6">
                    {group.name}
                  </h2>
                  <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {group.templates.map((template) => (
                      <li key={template.id}>
                        <Card
                          interactive
                          className="block h-full"
                          render={<Link href={`/parse/${template.id}`} />}
                        >
                          <p className="text-xs font-bold text-muted-foreground mb-2">
                            {template.sender}
                          </p>
                          <h3 className="font-bold text-lg mb-2">{template.title}</h3>
                          <p className="text-sm text-muted-foreground">{template.description}</p>
                          <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                            See the layout
                            <ArrowRight className="h-4 w-4" aria-hidden />
                          </span>
                        </Card>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      </main>
      <MailhooksFooter />
    </>
  );
}
