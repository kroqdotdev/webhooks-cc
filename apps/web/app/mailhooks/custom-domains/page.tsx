import { FeaturePage, FeatureTable } from "@/components/mailhooks/feature-page";
import { mailhooksFeature } from "@/lib/mailhooks-features";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";

const feature = mailhooksFeature("/custom-domains");

export const metadata = mailhooksMetadata({
  title: feature.title,
  description: feature.description,
  path: feature.path,
  keywords: feature.keywords,
});

export default function CustomDomainsPage() {
  return (
    <FeaturePage feature={feature}>
      <section className="mb-12">
        <h2 className="text-2xl md:text-3xl font-bold mb-4">The two records</h2>
        <p className="text-muted-foreground mb-6">
          For <code className="font-mono text-sm">inbound.acme.com</code>, added where the
          domain&apos;s DNS is managed. The TXT record proves the domain is yours; the MX record
          sends its mail to us.
        </p>
        <FeatureTable
          caption="DNS records for a custom inbound domain"
          columns={[
            { header: "Type" },
            { header: "Name", mono: true },
            { header: "Value", mono: true },
          ]}
          rows={[
            ["TXT", "_mailhooks.inbound.acme.com", "mailhooks-verify= and the page's token"],
            ["MX", "inbound.acme.com", "mx.mailhooks.cc"],
          ]}
        />
      </section>

      <section className="mb-12">
        <h2 className="text-2xl md:text-3xl font-bold mb-4">Each address to its endpoint</h2>
        <p className="text-muted-foreground mb-6">
          Only endpoints on the account, or shared with the team, can receive a domain&apos;s mail.
          Each one then reads its emails with its own layouts and sends them to its own
          destinations.
        </p>
        <FeatureTable
          caption="Where a domain's mail goes"
          columns={[{ header: "Mail to", mono: true }, { header: "Goes to" }]}
          rows={[
            ["orders@inbound.acme.com", "The Orders endpoint"],
            ["orders+test@inbound.acme.com", "The Orders endpoint, tagged test"],
            ["invoices@inbound.acme.com", "The Invoices endpoint"],
            ["any other address", "A catch-all endpoint, or refused"],
          ]}
        />
      </section>
    </FeaturePage>
  );
}
