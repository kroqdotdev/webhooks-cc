import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Dashboard Test Webhooks Docs",
  description:
    "Use the dashboard Send button to send manual requests or realistic provider webhook templates with signatures for end-to-end verification testing.",
  path: "/docs/endpoints/test-webhooks",
});

const providerRows = [
  {
    provider: "Stripe",
    presets: "payment_intent.succeeded, checkout.session.completed, invoice.paid",
    contentType: "application/json",
    signature: "stripe-signature (HMAC SHA-256 over timestamp.payload)",
  },
  {
    provider: "GitHub",
    presets: "push, pull_request.opened, ping",
    contentType: "application/json",
    signature: "x-hub-signature-256 (HMAC SHA-256 over raw body)",
  },
  {
    provider: "Shopify",
    presets: "orders/create, orders/paid, products/update, app/uninstalled",
    contentType: "application/json",
    signature: "x-shopify-hmac-sha256 (Base64 HMAC SHA-256 over raw body)",
  },
  {
    provider: "Twilio",
    presets: "messaging.inbound, messaging.status_callback, voice.incoming_call",
    contentType: "application/x-www-form-urlencoded",
    signature: "x-twilio-signature (Base64 HMAC SHA-1 over URL + sorted params)",
  },
] as const;

export default function DashboardTestWebhooksPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Dashboard test webhooks</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Use the <strong className="text-foreground">Send</strong> button in the dashboard URL bar to
        send a manual request or a signed provider template to your endpoint.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Open the sender</h2>
        <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
          <li>Open an endpoint in the dashboard.</li>
          <li>
            Click <strong className="text-foreground">Send</strong> in the URL bar.
          </li>
          <li>Select either manual mode or a provider template mode.</li>
          <li>Send the request and inspect the captured result in the request list.</li>
        </ol>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Manual mode</h2>
        <p className="text-muted-foreground mb-4">
          Manual mode lets you choose method, path, headers, and body. Use this when you need a
          custom request shape or when you are debugging a non-standard sender.
        </p>
        <pre className="neo-code text-sm">{`Method: POST
Path: /stripe/webhook
Headers:
  Content-Type: application/json
Body:
  {"event":"test.manual"}`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Provider template mode</h2>
        <p className="text-muted-foreground mb-4">
          Provider templates generate realistic payload structure and signature headers so you can
          test verification logic, not just transport.
        </p>

        <div className="neo-code text-sm overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-foreground/20">
                <th scope="col" className="text-left py-2 pr-4 font-bold">
                  Provider
                </th>
                <th scope="col" className="text-left py-2 pr-4 font-bold">
                  Presets
                </th>
                <th scope="col" className="text-left py-2 pr-4 font-bold">
                  Content-Type
                </th>
                <th scope="col" className="text-left py-2 font-bold">
                  Signature header
                </th>
              </tr>
            </thead>
            <tbody>
              {providerRows.map((row) => (
                <tr key={row.provider} className="border-b border-foreground/20 last:border-b-0">
                  <td className="py-2 pr-4 font-bold">{row.provider}</td>
                  <td className="py-2 pr-4">{row.presets}</td>
                  <td className="py-2 pr-4">
                    <code>{row.contentType}</code>
                  </td>
                  <td className="py-2">
                    <code>{row.signature}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Mock webhook secret and event override</h2>
        <p className="text-muted-foreground mb-4">
          Enter your provider signing secret in{" "}
          <strong className="text-foreground">Mock webhook secret</strong>. The sender signs the
          generated payload with that secret and sets the provider-specific signature header.
        </p>
        <p className="text-muted-foreground">
          Leave <strong className="text-foreground">Event/topic override</strong> empty to use the
          preset default. Use override only when you need to test a specific event name.
        </p>
        <p className="text-muted-foreground mt-3">
          Twilio signatures are computed from URL + sorted form params. If you override a Twilio
          body as a string, provide URL-encoded key/value pairs (not raw JSON).
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Verification checklist</h2>
        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
          <li>Verify your server reads the raw request body before parsing JSON.</li>
          <li>Verify signature checks fail if you change the secret.</li>
          <li>Verify your handler branches on provider event/topic correctly.</li>
          <li>Verify Twilio handlers parse form-encoded payloads.</li>
        </ul>
      </section>
    </article>
  );
}
