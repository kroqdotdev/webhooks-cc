import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Shopify Webhooks - webhooks.cc Docs",
  description: "Set up Shopify webhook testing with webhooks.cc.",
};

export default function ShopifyPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Shopify Webhooks</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Capture Shopify webhooks for order events, product updates, and more during local
        development.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">1. Create an endpoint</h2>
        <p className="text-muted-foreground mb-4">
          Create an endpoint in the{" "}
          <Link href="/dashboard" className="text-primary hover:underline font-bold">
            dashboard
          </Link>
          . Name it something like <code className="font-mono font-bold">Shopify Dev</code> and set
          the mock response to return <code className="font-mono font-bold">200 OK</code>. Shopify
          retries on non-2xx responses. Copy the generated URL from the URL bar.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">2. Register in Shopify</h2>
        <p className="text-muted-foreground mb-4">
          In your Shopify admin, go to{" "}
          <strong className="text-foreground">Settings &rarr; Notifications &rarr; Webhooks</strong>{" "}
          (or use the Shopify API):
        </p>
        <ul className="list-disc list-inside space-y-2 text-muted-foreground mb-4">
          <li>
            <strong className="text-foreground">URL:</strong> paste your endpoint URL (e.g.,{" "}
            <code className="font-mono">https://go.webhooks.cc/w/&lt;slug&gt;</code>)
          </li>
          <li>
            <strong className="text-foreground">Format:</strong> JSON
          </li>
          <li>
            <strong className="text-foreground">Events:</strong> select the topics you need
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">Or register via the API:</p>
        <pre className="neo-code text-sm mt-3">{`POST /admin/api/2024-01/webhooks.json
{
  "webhook": {
    "topic": "orders/create",
    "address": "https://go.webhooks.cc/w/<slug>",
    "format": "json"
  }
}`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">3. Forward to localhost</h2>
        <pre className="neo-code text-sm">{`whk tunnel 3000`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">4. Test with a test order</h2>
        <p className="text-muted-foreground">
          Create a test order in your Shopify development store. The webhook fires and appears in
          your webhooks.cc dashboard. Use the{" "}
          <strong className="text-foreground">Send test notification</strong> button in
          Shopify&apos;s webhook settings for a quick test.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Common topics</h2>
        <div className="neo-code text-sm overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-foreground/20">
                <th className="text-left py-1.5 pr-4 font-bold">Topic</th>
                <th className="text-left py-1.5 font-bold">Trigger</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-foreground/20">
                <td className="py-1.5 pr-4">
                  <code>orders/create</code>
                </td>
                <td className="py-1.5 text-muted-foreground">New order placed</td>
              </tr>
              <tr className="border-b border-foreground/20">
                <td className="py-1.5 pr-4">
                  <code>orders/paid</code>
                </td>
                <td className="py-1.5 text-muted-foreground">Order payment captured</td>
              </tr>
              <tr className="border-b border-foreground/20">
                <td className="py-1.5 pr-4">
                  <code>products/update</code>
                </td>
                <td className="py-1.5 text-muted-foreground">Product details changed</td>
              </tr>
              <tr className="border-b border-foreground/20">
                <td className="py-1.5 pr-4">
                  <code>customers/create</code>
                </td>
                <td className="py-1.5 text-muted-foreground">New customer registered</td>
              </tr>
              <tr>
                <td className="py-1.5 pr-4">
                  <code>app/uninstalled</code>
                </td>
                <td className="py-1.5 text-muted-foreground">Your app removed from a store</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">HMAC verification</h2>
        <p className="text-muted-foreground">
          Shopify signs webhooks with HMAC-SHA256 using your app&apos;s shared secret. The{" "}
          <code className="font-mono font-bold">x-shopify-hmac-sha256</code> header is preserved
          when forwarding, so your local server can verify the signature using the raw request body.
        </p>
      </section>
    </article>
  );
}
