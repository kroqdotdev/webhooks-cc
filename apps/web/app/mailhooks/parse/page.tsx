import Link from "next/link";
import { SiteHeader } from "@/components/nav/site-header";
import { MailhooksFooter } from "@/components/mailhooks/mailhooks-footer";
import { LAYOUT_TEMPLATES } from "@/lib/layout-templates";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";

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
          <h1 className="text-4xl md:text-5xl font-bold mb-4">Ready-made layouts</h1>
          <p className="text-xl text-muted-foreground mb-12 max-w-2xl">
            Each one reads a common kind of email into fields and line items. Add it to an endpoint
            and adjust it on one of your own emails in the preview.
          </p>
          <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {LAYOUT_TEMPLATES.map((template) => (
              <li key={template.id}>
                <Link href={`/parse/${template.id}`} className="ui-card block h-full">
                  <p className="text-xs font-bold caps text-muted-foreground mb-2">
                    {template.sender}
                  </p>
                  <h2 className="font-bold text-lg mb-2">{template.title}</h2>
                  <p className="text-sm text-muted-foreground">{template.description}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </main>
      <MailhooksFooter />
    </>
  );
}
