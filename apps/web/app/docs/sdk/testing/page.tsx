import { createPageMetadata } from "@/lib/seo";
import { JsonLd, howToSchema } from "@/lib/schemas";

export const metadata = createPageMetadata({
  title: "SDK Testing Docs",
  description: "Use the webhooks.cc SDK in your CI/CD pipeline to verify webhook integrations.",
  path: "/docs/sdk/testing",
});

export default function TestingPage() {
  return (
    <article>
      <JsonLd
        data={howToSchema({
          name: "How to test webhooks in TypeScript",
          description:
            "Use the webhooks.cc SDK to verify webhook integrations end-to-end in your CI/CD pipeline.",
          totalTime: "PT5M",
          steps: [
            {
              name: "Install the SDK",
              text: "Run npm install @webhooks-cc/sdk to add the SDK to your project.",
            },
            {
              name: "Create a temporary endpoint",
              text: "In your test setup (beforeAll), create an endpoint with client.endpoints.create(). This gives you a unique URL to receive webhooks.",
            },
            {
              name: "Trigger your application",
              text: "Call your application with the endpoint URL so it sends the webhook to webhooks.cc instead of the production destination.",
            },
            {
              name: "Wait for the webhook",
              text: "Use client.requests.waitFor(endpoint.slug) to poll until the webhook arrives. Add matchers to filter by method, headers, or body content.",
            },
            {
              name: "Assert and clean up",
              text: "Assert on the captured request body and headers. Delete the endpoint in afterAll to clean up.",
            },
          ],
        })}
      />
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Testing</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Use the SDK in your test suite to verify webhook integrations end-to-end. Create temporary
        endpoints, trigger your application, and assert on the captured requests.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Pattern: test, assert, cleanup</h2>
        <pre className="neo-code text-sm">{`import { WebhooksCC } from "@webhooks-cc/sdk";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const client = new WebhooksCC({
  apiKey: process.env.WHK_API_KEY!,
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
  WHK_API_KEY: \${{ secrets.WHK_API_KEY }}

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
          <li>
            Always clean up endpoints in <code className="font-mono font-bold">afterAll</code> /{" "}
            <code className="font-mono font-bold">afterEach</code>
          </li>
          <li>The free plan supports 200 requests/day — enough for most test suites</li>
        </ul>
      </section>
    </article>
  );
}
