import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Quick Start - webhooks.cc Docs",
  description: "Get started with webhooks.cc in three steps: create an endpoint, send a webhook, and view it in the dashboard.",
};

export default function DocsPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Quick Start</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Start capturing webhooks in under a minute. Three steps, no configuration.
      </p>

      {/* Step 1 */}
      <section className="mb-10">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-8 h-8 border-2 border-foreground bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm shrink-0">
            1
          </span>
          <h2 className="text-xl font-bold">Create an endpoint</h2>
        </div>
        <p className="text-muted-foreground mb-4">
          Sign in and click <strong className="text-foreground">New Endpoint</strong> in the dashboard.
          You get a unique URL like:
        </p>
        <pre className="neo-code text-sm mb-4">https://go.webhooks.cc/w/&lt;slug&gt;</pre>
        <p className="text-sm text-muted-foreground">
          Or create one programmatically with the{" "}
          <Link href="/docs/sdk" className="text-primary hover:underline font-bold">SDK</Link> or{" "}
          <Link href="/docs/cli" className="text-primary hover:underline font-bold">CLI</Link>.
        </p>
      </section>

      {/* Step 2 */}
      <section className="mb-10">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-8 h-8 border-2 border-foreground bg-secondary text-secondary-foreground flex items-center justify-center font-bold text-sm shrink-0">
            2
          </span>
          <h2 className="text-xl font-bold">Send a webhook</h2>
        </div>
        <p className="text-muted-foreground mb-4">
          Point your service at the endpoint URL. Or test it with curl:
        </p>
        <pre className="neo-code text-sm mb-4">{`curl -X POST https://go.webhooks.cc/w/<slug> \\
  -H "Content-Type: application/json" \\
  -d '{"event": "payment.success", "amount": 4999}'`}</pre>
        <p className="text-sm text-muted-foreground">
          The receiver accepts any HTTP method, content type, and body.
        </p>
      </section>

      {/* Step 3 */}
      <section className="mb-10">
        <div className="flex items-center gap-3 mb-4">
          <span className="w-8 h-8 border-2 border-foreground bg-accent text-accent-foreground flex items-center justify-center font-bold text-sm shrink-0">
            3
          </span>
          <h2 className="text-xl font-bold">View in the dashboard</h2>
        </div>
        <p className="text-muted-foreground mb-4">
          Open the{" "}
          <Link href="/dashboard" className="text-primary hover:underline font-bold">dashboard</Link>.
          Requests appear in real-time. Inspect headers, body, query parameters, and metadata.
          Copy as curl, replay to another URL, or export as JSON/CSV.
        </p>
      </section>

      {/* Next steps */}
      <section className="border-t-2 border-foreground pt-8">
        <h2 className="text-xl font-bold mb-4">Next steps</h2>
        <ul className="space-y-2">
          <li>
            <Link href="/docs/mock-responses" className="text-primary hover:underline font-bold">
              Configure mock responses
            </Link>{" "}
            <span className="text-muted-foreground">- control what your endpoint returns</span>
          </li>
          <li>
            <Link href="/docs/cli/tunnel" className="text-primary hover:underline font-bold">
              Set up local tunneling
            </Link>{" "}
            <span className="text-muted-foreground">- forward webhooks to localhost</span>
          </li>
          <li>
            <Link href="/docs/sdk" className="text-primary hover:underline font-bold">
              Use the SDK
            </Link>{" "}
            <span className="text-muted-foreground">- integrate webhooks.cc into your test suite</span>
          </li>
          <li>
            <Link href="/docs/webhooks/stripe" className="text-primary hover:underline font-bold">
              Integration guides
            </Link>{" "}
            <span className="text-muted-foreground">- Stripe, GitHub, Shopify setup</span>
          </li>
        </ul>
      </section>
    </article>
  );
}
