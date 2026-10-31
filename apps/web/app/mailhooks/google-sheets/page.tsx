import Link from "next/link";
import { FeaturePage, FeatureTable } from "@/components/mailhooks/feature-page";
import { mailhooksFeature } from "@/lib/mailhooks-features";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";

const feature = mailhooksFeature("/google-sheets");

export const metadata = mailhooksMetadata({
  title: feature.title,
  description: feature.description,
  path: feature.path,
  keywords: feature.keywords,
});

export default function GoogleSheetsPage() {
  return (
    <FeaturePage feature={feature}>
      <section className="mb-12">
        <h2 className="text-2xl md:text-3xl font-bold mb-4">A row per email, or per line item</h2>
        <p className="text-muted-foreground mb-6">
          Take an order email from Acme with two products, read by a layout that finds the order
          number, the total and the line items. With a row per email, the order takes one line:
        </p>
        <FeatureTable
          caption="One row per email"
          columns={[
            { header: "From", note: "{{ from.address }}" },
            { header: "Subject", note: "{{ subject }}" },
            { header: "Order", note: "{{ parsed.fields.order }}" },
            { header: "Total", note: "{{ parsed.fields.total }}" },
          ]}
          rows={[["orders@acme.example", "Order #1001 confirmed", "1001", "37.50"]]}
        />
        <p className="text-muted-foreground mt-8 mb-6">
          With a row per line item, each product gets a line of its own, and the order&apos;s values
          can sit beside the item&apos;s:
        </p>
        <FeatureTable
          caption="One row per line item"
          columns={[
            { header: "Order", note: "{{ parsed.fields.order }}" },
            { header: "SKU", note: "{{ item.sku }}" },
            { header: "Qty", note: "{{ item.qty }}" },
            { header: "Price", note: "{{ item.price }}" },
          ]}
          rows={[
            ["1001", "ACME-TEE-M", "2", "12.50"],
            ["1001", "ACME-MUG", "1", "12.50"],
          ]}
        />
        <p className="text-sm text-muted-foreground mt-4">
          An email without line items still adds one row. Start from a{" "}
          <Link href="/parse" className="text-primary font-bold hover:underline">
            ready-made layout
          </Link>{" "}
          for Shopify, WooCommerce or Etsy orders, which reads their line items, then check it on
          one of your own emails in the preview.
        </p>
      </section>
    </FeaturePage>
  );
}
