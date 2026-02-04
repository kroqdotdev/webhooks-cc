import type { Metadata } from "next";


export const metadata: Metadata = {
  title: "Testing with the SDK - webhooks.cc Docs",
  description: "Use the webhooks.cc SDK in your CI/CD pipeline to verify webhook integrations.",
};

export default function TestingPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Testing</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Use the SDK in your test suite to verify webhook integrations end-to-end.
        Create temporary endpoints, trigger your application, and assert on the captured requests.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Pattern: test, assert, cleanup</h2>
        <pre className="neo-code text-sm">{`import { WebhooksCC } from "@webhookscc/sdk";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const client = new WebhooksCC({
  apiKey: process.env.WEBHOOKS_API_KEY!,
});

describe("payment webhooks", () => {
  let endpoint: Awaited<ReturnType<typeof client.endpoints.create>>;

  beforeAll(async () => {
    endpoint = await client.endpoints.create({
      name: "test-payments",
    });
  });

  afterAll(async () => {
    await client.endpoints.delete(endpoint.slug);
  });

  it("sends a webhook on successful payment", async () => {
    // Trigger your application with the endpoint URL
    await processPayment({
      webhookUrl: endpoint.url,
      amount: 4999,
    });

    // Wait for the webhook to arrive
    const request = await client.requests.waitFor(endpoint.slug, {
      timeout: 5000,
      match: (r) => r.method === "POST",
    });

    const body = JSON.parse(request.body!);
    expect(body.event).toBe("payment.success");
    expect(body.amount).toBe(4999);
  });
});`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">CI/CD integration</h2>
        <p className="text-muted-foreground mb-4">
          Add your API key as a secret in your CI environment. Example GitHub Actions config:
        </p>
        <pre className="neo-code text-sm">{`# .github/workflows/test.yml
env:
  WEBHOOKS_API_KEY: \${{ secrets.WEBHOOKS_API_KEY }}

steps:
  - uses: actions/checkout@v4
  - run: npm ci
  - run: npm test`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Using waitFor</h2>
        <p className="text-muted-foreground mb-4">
          The SDK includes a built-in <code className="font-mono font-bold">waitFor</code> method
          that polls until a matching request arrives:
        </p>
        <pre className="neo-code text-sm">{`// Wait for any request
const req = await client.requests.waitFor(endpoint.slug);

// Wait for a POST with a specific body
const req = await client.requests.waitFor(endpoint.slug, {
  timeout: 10000,
  pollInterval: 500,
  match: (r) => {
    if (r.method !== "POST") return false;
    const body = JSON.parse(r.body ?? "{}");
    return body.event === "order.created";
  },
});`}</pre>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Tips</h2>
        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
          <li>Use unique endpoint names per test run to avoid conflicts in parallel CI</li>
          <li>Always clean up endpoints in <code className="font-mono font-bold">afterAll</code> / <code className="font-mono font-bold">afterEach</code></li>
          <li>Set a mock response if your application checks the webhook delivery status</li>
          <li>The free plan supports 200 requests/day, enough for most test suites</li>
        </ul>
      </section>
    </article>
  );
}
