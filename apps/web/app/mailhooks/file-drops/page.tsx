import { FeaturePage } from "@/components/mailhooks/feature-page";
import { mailhooksFeature } from "@/lib/mailhooks-features";
import { mailhooksMetadata } from "@/lib/mailhooks-seo";

const feature = mailhooksFeature("/file-drops");

export const metadata = mailhooksMetadata({
  title: feature.title,
  description: feature.description,
  path: feature.path,
  keywords: feature.keywords,
});

const SERVERS = [
  {
    name: "SFTP",
    text: "Host, port (22), username, and a password or a private key (OpenSSH or PEM). The server's host key is pinned on the first connection, and a different one later stops the drop, as ssh would.",
  },
  {
    name: "FTPS and FTP",
    text: "Host, port (21), username and password. FTPS uses explicit TLS; plain FTP sends the password and the files unencrypted, so keep it for servers that offer nothing else.",
  },
  {
    name: "S3-compatible",
    text: "AWS, Cloudflare R2, Hetzner, MinIO, Backblaze and the like: the endpoint URL, region, bucket, and an access key that only needs to write objects.",
  },
];

const CSV_SAMPLE = `Order,SKU,Qty,Price
1001,ACME-TEE-M,2,12.50
1001,ACME-MUG,1,12.50`;

const XML_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rows>
  <row>
    <Order>1001</Order>
    <SKU>ACME-TEE-M</SKU>
    <Qty>2</Qty>
    <Price>12.50</Price>
  </row>
  <row>
    <Order>1001</Order>
    <SKU>ACME-MUG</SKU>
    <Qty>1</Qty>
    <Price>12.50</Price>
  </row>
</rows>`;

export default function FileDropsPage() {
  return (
    <FeaturePage feature={feature}>
      <section className="mb-12">
        <h2 className="text-2xl md:text-3xl font-bold mb-6">Where the files go</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {SERVERS.map((server) => (
            <div key={server.name} className="ui-card ui-card-static">
              <h3 className="font-bold mb-1.5">{server.name}</h3>
              <p className="text-sm text-muted-foreground">{server.text}</p>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground mt-4">
          On SFTP and FTP the folder must exist and is relative to the login&apos;s home folder; on
          S3 it is the key prefix. For a self-signed certificate, enter its SHA-256 fingerprint and
          only that certificate is accepted.
        </p>
      </section>

      <section className="mb-12">
        <h2 className="text-2xl md:text-3xl font-bold mb-4">What lands in the folder</h2>
        <p className="text-muted-foreground mb-6">
          An order email from Acme, as a file per email with a row per line item and the prefix{" "}
          <code className="font-mono text-sm">orders-</code>. The same columns can be written as
          XML, where each row is a <code className="font-mono text-sm">&lt;row&gt;</code> element
          with an element per column, named after its header:
        </p>
        <p className="font-mono text-sm mb-3 break-all">orders-20261029-173326-3f2a9c1e.csv</p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{CSV_SAMPLE}</code>
            </pre>
          </div>
          <div className="ui-code overflow-x-auto">
            <pre className="text-sm">
              <code>{XML_SAMPLE}</code>
            </pre>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-4">
          A CSV cell that a spreadsheet would read as a formula is written as text. JSON files hold
          each email as signed JSON sends it, parsed fields and line items included.
        </p>
      </section>
    </FeaturePage>
  );
}
