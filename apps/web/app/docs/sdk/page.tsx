import Link from "next/link";
import { createPageMetadata } from "@/lib/seo";
import { JsonLd, faqSchema, type FAQItem } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "SDK Overview Docs",
  description:
    "The webhooks.cc TypeScript SDK for programmatic endpoint management and webhook inspection.",
  path: "/docs/sdk",
});

const SDK_FAQ: FAQItem[] = [
  {
    question: "What language does the webhooks.cc SDK support?",
    answer:
      "The SDK is written in TypeScript and works with any JavaScript or TypeScript runtime including Node.js, Bun, and Deno. Install with npm, pnpm, yarn, or bun.",
  },
  {
    question: "Can I use the webhooks.cc SDK in CI/CD pipelines?",
    answer:
      "Yes. Add your API key as a CI secret and run tests with any test runner. The SDK supports Vitest, Jest, Mocha, and any framework that runs async Node.js code.",
  },
];

export default function SdkPage() {
  return (
    <article>
      <JsonLd data={faqSchema(SDK_FAQ)} />
      <h1 className="text-3xl md:text-4xl font-bold mb-4">SDK</h1>
      <p className="text-lg text-muted-foreground mb-10">
        The TypeScript SDK lets you create endpoints, capture and replay requests, stream webhooks
        in real-time, and integrate webhooks.cc into your test suite programmatically.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Install</h2>
        <pre className="neo-code text-sm mb-4">{`npm install @webhooks-cc/sdk`}</pre>
        <p className="text-sm text-muted-foreground">
          See{" "}
          <Link href="/installation" className="text-primary hover:underline font-bold">
            all installation options
          </Link>
          .
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Authentication</h2>
        <p className="text-muted-foreground mb-4">
          Generate an API key from your{" "}
          <Link href="/account" className="text-primary hover:underline font-bold">
            account page
          </Link>
          . Pass it when creating the client:
        </p>
        <pre className="neo-code text-sm">{`import { WebhooksCC } from "@webhooks-cc/sdk";

const client = new WebhooksCC({
  apiKey: process.env.WHK_API_KEY,
});`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Create an endpoint</h2>
        <pre className="neo-code text-sm">{`const endpoint = await client.endpoints.create({
  name: "test-payments",
});

console.log(endpoint.url);
// https://go.webhooks.cc/w/<slug>`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Send a test webhook</h2>
        <pre className="neo-code text-sm">{`await client.endpoints.send(endpoint.slug, {
  method: "POST",
  headers: { "x-event-type": "payment.success" },
  body: { amount: 4999, currency: "usd" },
});`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Wait for a request</h2>
        <p className="text-muted-foreground mb-4">
          Timeouts accept human-readable strings like{" "}
          <code className="font-mono font-bold">&quot;30s&quot;</code>,{" "}
          <code className="font-mono font-bold">&quot;5m&quot;</code>, or milliseconds.
        </p>
        <pre className="neo-code text-sm">{`import { matchMethod, matchBodyPath } from "@webhooks-cc/sdk";

const request = await client.requests.waitFor(endpoint.slug, {
  timeout: "10s",
  match: matchBodyPath("event", "payment.success"),
});

console.log(request.body);`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Stream requests in real-time</h2>
        <pre className="neo-code text-sm">{`for await (const request of client.requests.subscribe(endpoint.slug)) {
  console.log(request.method, request.path);
  if (request.method === "POST") break;
}`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Replay a captured request</h2>
        <pre className="neo-code text-sm">{`const response = await client.requests.replay(
  request.id,
  "http://localhost:3000/webhooks"
);

console.log(response.status); // 200`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Detect webhook providers</h2>
        <pre className="neo-code text-sm">{`import {
  isStripeWebhook,
  isGitHubWebhook,
  isShopifyWebhook,
  isSlackWebhook,
} from "@webhooks-cc/sdk";

if (isStripeWebhook(request)) {
  console.log("Stripe webhook received");
}`}</pre>
      </section>

      <section className="border-t-2 border-foreground pt-8">
        <h2 className="text-xl font-bold mb-4">Learn more</h2>
        <ul className="space-y-2">
          <li>
            <Link href="/docs/sdk/api" className="text-primary hover:underline font-bold">
              API Reference
            </Link>{" "}
            <span className="text-muted-foreground">- all methods, matchers, and types</span>
          </li>
          <li>
            <Link href="/docs/sdk/testing" className="text-primary hover:underline font-bold">
              Testing patterns
            </Link>{" "}
            <span className="text-muted-foreground">- CI/CD integration examples</span>
          </li>
          <li>
            <Link href="/docs/mcp" className="text-primary hover:underline font-bold">
              MCP Server
            </Link>{" "}
            <span className="text-muted-foreground">
              - AI agent integration for Claude, Cursor, VS Code
            </span>
          </li>
        </ul>
      </section>
    </article>
  );
}
