import Link from "next/link";
import { FeaturePage, FeatureTable } from "@/components/mailhooks/feature-page";
import { mailhooksFeature } from "@/lib/mailhooks-features";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";
import { webhooksOrigin } from "@/lib/site";

const feature = mailhooksFeature("/integrations");

export const metadata = mailhooksMetadata({
  title: feature.title,
  description: feature.description,
  path: feature.path,
  keywords: feature.keywords,
});

const SAMPLE = `{
  "type": "email.received",
  "timestamp": "2026-10-29T17:33:26.882Z",
  "data": {
    "id": "3f2a9c1e-0000-4000-8000-000000000000",
    "endpoint": { "slug": "orders-acme", "name": "Orders" },
    "address": "orders-acme@mailhooks.cc",
    "subject": "Order #1001 confirmed",
    "from": { "name": "Acme Store", "address": "orders@acme.example" },
    "parsed": {
      "status": "matched",
      "layout": { "id": "orders", "name": "Acme orders" },
      "fields": { "order": "1001", "total": "37.50" },
      "lineItems": [
        { "sku": "ACME-TEE-M", "qty": "2", "price": "12.50" },
        { "sku": "ACME-MUG", "qty": "1", "price": "12.50" }
      ]
    },
    "...": "..."
  }
}`;

export default function IntegrationsPage() {
  return (
    <FeaturePage feature={feature}>
      <section className="mb-12">
        <div className="ui-card ui-card-static border-primary mb-8">
          <h2 className="font-bold text-lg mb-1">The apps are in review</h2>
          <p className="text-sm text-muted-foreground">
            Our Zapier and Make apps are not listed in the Zapier or Make directories yet. The steps
            above work today with the tools both already have: a Webhooks by Zapier catch hook and a
            Make custom webhook. Once the apps are listed, they add and remove that destination for
            you.
          </p>
        </div>
        <h2 className="text-2xl md:text-3xl font-bold mb-4">What the apps offer</h2>
        <p className="text-muted-foreground mb-6">
          Both connect with an API key. The trigger is a REST hook: turning a Zap or scenario on
          adds a JSON destination for emails to the endpoint you pick, and turning it off removes
          it.
        </p>
        <FeatureTable
          caption="The Zapier and Make apps"
          columns={[{ header: "What" }, { header: "Zapier" }, { header: "Make" }]}
          rows={[
            ["Trigger", "New Email (instant)", "Watch emails (instant)"],
            [
              "Actions",
              "Create Endpoint, Send Test Email",
              "Create an endpoint, Send a test email",
            ],
            ["Search", "Find Email: the newest match", "Search emails: newest first"],
          ]}
        />
      </section>

      <section className="mb-12">
        <h2 className="text-2xl md:text-3xl font-bold mb-4">What a Zap or scenario receives</h2>
        <p className="text-muted-foreground mb-6">
          One <code className="font-mono text-sm">POST</code> per email, the same signed JSON any
          destination gets. On an endpoint with layouts,{" "}
          <code className="font-mono text-sm">data.parsed</code> holds the fields and line items:
        </p>
        <div className="ui-code overflow-x-auto">
          <pre className="text-sm">
            <code>{SAMPLE}</code>
          </pre>
        </div>
        <p className="text-sm text-muted-foreground mt-3">
          Shortened. The full JSON also carries the recipients, the text and HTML, the attachments
          (as signed links by default), the sender checks and the headers; see{" "}
          <Link
            href={`${webhooksOrigin()}/docs/forwarding#signed-json`}
            className="text-primary font-bold hover:underline"
          >
            Signed JSON
          </Link>
          .
        </p>
      </section>
    </FeaturePage>
  );
}
