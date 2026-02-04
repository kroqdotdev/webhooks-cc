import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "SDK Overview - webhooks.cc Docs",
  description: "The webhooks.cc TypeScript SDK for programmatic endpoint management and webhook inspection.",
};

export default function SdkPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">SDK</h1>
      <p className="text-lg text-muted-foreground mb-10">
        The TypeScript SDK lets you create endpoints, read captured requests, and integrate webhooks.cc
        into your application or test suite programmatically.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Install</h2>
        <pre className="neo-code text-sm mb-4">{`npm install @webhookscc/sdk`}</pre>
        <p className="text-sm text-muted-foreground">
          See <Link href="/installation" className="text-primary hover:underline font-bold">all installation options</Link>.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Authentication</h2>
        <p className="text-muted-foreground mb-4">
          Generate an API key from your{" "}
          <Link href="/account" className="text-primary hover:underline font-bold">account page</Link>.
          Pass it when creating the client:
        </p>
        <pre className="neo-code text-sm">{`import { WebhooksCC } from "@webhookscc/sdk";

const client = new WebhooksCC({
  apiKey: process.env.WEBHOOKS_API_KEY,
});`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Create an endpoint</h2>
        <pre className="neo-code text-sm">{`const endpoint = await client.endpoints.create({
  name: "test-payments",
  mockResponse: {         // optional
    status: 200,
    body: '{"received": true}',
    headers: { "Content-Type": "application/json" },
  },
});

console.log(endpoint.url);
// https://go.webhooks.cc/w/<slug>`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Read captured requests</h2>
        <pre className="neo-code text-sm">{`const requests = await client.requests.list(endpoint.slug, {
  limit: 10,
});

for (const req of requests) {
  console.log(req.method, req.path, req.body);
}`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Wait for a request</h2>
        <pre className="neo-code text-sm">{`const request = await client.requests.waitFor(endpoint.slug, {
  timeout: 10000,
  match: (r) => r.method === "POST",
});

console.log(request.body);`}</pre>
      </section>

      <section className="border-t-2 border-foreground pt-8">
        <h2 className="text-xl font-bold mb-4">Learn more</h2>
        <ul className="space-y-2">
          <li>
            <Link href="/docs/sdk/api" className="text-primary hover:underline font-bold">
              API Reference
            </Link>{" "}
            <span className="text-muted-foreground">- all methods and types</span>
          </li>
          <li>
            <Link href="/docs/sdk/testing" className="text-primary hover:underline font-bold">
              Testing patterns
            </Link>{" "}
            <span className="text-muted-foreground">- CI/CD integration examples</span>
          </li>
        </ul>
      </section>
    </article>
  );
}
