import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Webhook Endpoints Guide",
  description:
    "Learn how to create, organize, and manage webhook endpoints in webhooks.cc, including slugs, URL formats, and endpoint settings.",
  path: "/docs/endpoints",
});

export default function EndpointsPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Endpoints</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Endpoints are unique URLs that capture incoming webhooks. Each endpoint has its own request
        history, mock response configuration, and settings.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Creating an endpoint</h2>
        <p className="text-muted-foreground mb-4">
          Click <strong className="text-foreground">New Endpoint</strong> in the dashboard header.
          Give it a name and configure an optional mock response.
        </p>
        <p className="text-muted-foreground mb-4">
          Each endpoint gets an auto-generated slug that forms its webhook URL:
        </p>
        <pre className="neo-code text-sm mb-4">https://go.webhooks.cc/w/&lt;slug&gt;</pre>
        <p className="text-sm text-muted-foreground">
          Copy the full URL from the dashboard URL bar.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Switching endpoints</h2>
        <p className="text-muted-foreground">
          Use the endpoint switcher dropdown in the dashboard header to switch between endpoints.
          The request list updates in real-time when you switch.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Sending test webhooks from the dashboard</h2>
        <p className="text-muted-foreground mb-4">
          Use the <strong className="text-foreground">Send</strong> button in the URL bar to send a
          manual request or a signed provider template (Stripe, GitHub, Shopify, Twilio).
        </p>
        <p className="text-muted-foreground">
          See{" "}
          <Link
            href="/docs/endpoints/test-webhooks"
            className="text-primary hover:underline font-bold"
          >
            Dashboard test webhook docs
          </Link>{" "}
          for template presets, signature headers, and verification tips.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Endpoint settings</h2>
        <p className="text-muted-foreground mb-4">
          Click the gear icon next to the endpoint name in the URL bar to open settings. You can:
        </p>
        <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
          <li>Rename the endpoint</li>
          <li>
            Configure a{" "}
            <Link href="/docs/mock-responses" className="text-primary hover:underline font-bold">
              mock response
            </Link>
          </li>
          <li>Delete the endpoint and all its captured requests</li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Limits</h2>
        <div className="neo-code text-sm">
          <table className="w-full">
            <thead>
              <tr className="border-b border-foreground/20">
                <th className="text-left py-2 pr-4 font-bold">Plan</th>
                <th className="text-left py-2 pr-4 font-bold">Endpoints</th>
                <th className="text-left py-2 pr-4 font-bold">Requests</th>
                <th className="text-left py-2 font-bold">Retention</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-foreground/20">
                <td className="py-2 pr-4">Free</td>
                <td className="py-2 pr-4">Unlimited</td>
                <td className="py-2 pr-4">200/day</td>
                <td className="py-2">7 days</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-bold">Pro</td>
                <td className="py-2 pr-4">Unlimited</td>
                <td className="py-2 pr-4">500K/month</td>
                <td className="py-2">30 days</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </article>
  );
}
